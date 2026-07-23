/**
 * providers/codex/provider.ts — OpenAI Codex CLI 监控 provider。
 *
 * Codex 把每个会话写成 append-only 的 rollout JSONL：
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl
 * 无显式 status——tail 尾读增量行，按 event_msg 推导状态（见 rollout.reduceCodexState）。
 *
 * 作用域：启动只引导「最近窗口内」的 rollout（避免加载海量历史）；之后 chokidar
 * 捕获新建/续写的文件即活跃会话。DEAD 依据：shutdown_complete 事件，或
 * WORKING 态长时间无写入（进程疑似被杀）的兜底。
 */

import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { open, readdir, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import type { Config, SessionState } from '../../types.ts';
import { isSecretPath, truncateContext } from '../../config.ts';
import type { Provider, ProviderPatch, SessionSink } from '../types.ts';
import { codexSessionsDir, parseRolloutLine, reduceCodexState, type RolloutLine } from './rollout.ts';

const NL = 0x0a;
const RECENT_WINDOW_MS = 12 * 3_600_000;
const SWEEP_INTERVAL_MS = 30_000;
const WORKING_DEAD_MS = 10 * 60_000;
const RECENT_REPLIES_MAX = 5;

/** 每个 rollout 文件的尾读状态 + 累积字段（原始值，emit 时截断）。 */
interface Tracked {
  path: string;
  sessionId?: string;
  offset: number;
  partial: Buffer;
  chain: Promise<void>;
  state?: SessionState;
  cwd?: string;
  model?: string;
  effort?: string;
  gitBranch?: string;
  lastPrompt?: string;
  lastAssistant?: string;
  recentReplies: string[];
  contextTokens?: number;
  contextWindow?: number;
  startedAt?: number;
  lastRecordAt?: number;
  mtimeMs: number;
  emittedDead: boolean;
}

export interface CodexProviderOptions {
  now?: () => number;
  codexHome?: string;
}

export class CodexProvider implements Provider {
  readonly agent = 'codex' as const;

  private readonly cfg: Config;
  private readonly sessionsDir: string;
  private readonly now: () => number;
  private sink: SessionSink | undefined;
  private watcher: FSWatcher | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  private readonly tracked = new Map<string, Tracked>();

  constructor(cfg: Config, opts: CodexProviderOptions = {}) {
    this.cfg = cfg;
    const home = opts.codexHome ?? cfg.providers?.codex?.codexHome ?? join(homedir(), '.codex');
    this.sessionsDir = codexSessionsDir(home);
    this.now = opts.now ?? Date.now;
  }

  async start(sink: SessionSink): Promise<void> {
    this.sink = sink;
    await this.bootstrap();
    // chokidar v4 无 glob：监听 sessions 目录，depth 覆盖 YYYY/MM/DD/file，按扩展名过滤。
    this.watcher = chokidar.watch(this.sessionsDir, {
      ignoreInitial: true,
      depth: 4,
      ignored: (p: string, stats?: Stats) => (stats?.isFile() ? !p.endsWith('.jsonl') : false),
    });
    this.watcher.on('add', (p) => this.onFsEvent(p)).on('change', (p) => this.onFsEvent(p));
    await new Promise<void>((resolve) => {
      this.watcher!.on('ready', () => resolve());
    });
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = undefined;
    }
  }

  private pad(n: number): string {
    return String(n).padStart(2, '0');
  }

  /** 启动引导：只扫最近 1-2 个日期桶里 mtime 在窗口内的 rollout，读出当前状态。 */
  private async bootstrap(): Promise<void> {
    const now = this.now();
    const pending: Promise<void>[] = [];
    for (const daysAgo of [0, 1]) {
      const d = new Date(now - daysAgo * 86_400_000);
      const dir = join(this.sessionsDir, String(d.getFullYear()), this.pad(d.getMonth() + 1), this.pad(d.getDate()));
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const p = join(dir, f);
        try {
          const st = await stat(p);
          if (now - st.mtimeMs <= RECENT_WINDOW_MS) pending.push(this.trackFile(p, st.mtimeMs));
        } catch {
          /* skip */
        }
      }
    }
    await Promise.all(pending);
  }

  private onFsEvent(path: string): void {
    if (isSecretPath(path) || !path.endsWith('.jsonl')) return;
    if (!this.tracked.has(path)) void this.trackFile(path, this.now());
    else void this.enqueue(path, () => this.readIncremental(path));
  }

  private trackFile(path: string, mtimeMs: number): Promise<void> {
    if (this.tracked.has(path)) return Promise.resolve();
    this.tracked.set(path, {
      path,
      offset: 0,
      partial: Buffer.alloc(0),
      chain: Promise.resolve(),
      recentReplies: [],
      mtimeMs,
      emittedDead: false,
    });
    return this.enqueue(path, () => this.readIncremental(path));
  }

  /** 串行化同文件读操作，绝不并发；处理器绝不抛出。 */
  private enqueue(path: string, fn: () => Promise<void>): Promise<void> {
    const t = this.tracked.get(path);
    if (!t) return Promise.resolve();
    const run = t.chain.then(async () => {
      if (!this.tracked.has(path)) return;
      try {
        await fn();
      } catch {
        /* 事件处理器绝不抛出 */
      }
    });
    t.chain = run.catch(() => undefined);
    return run;
  }

  private async readIncremental(path: string): Promise<void> {
    const t = this.tracked.get(path);
    if (!t || !this.sink) return;
    let st: Stats;
    try {
      st = await stat(path);
    } catch {
      return;
    }
    t.mtimeMs = st.mtimeMs;
    const size = st.size;
    if (size < t.offset) {
      t.offset = 0;
      t.partial = Buffer.alloc(0);
    }
    if (size === t.offset) return;
    const len = size - t.offset;
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, t.offset);
      this.consume(t, buf);
    } finally {
      await fh.close();
    }
    t.offset = size;
    this.emit(t);
  }

  /** 以换行为边界解码，末尾残片留待下次，避免多字节 UTF-8 被 chunk 边界截断。 */
  private consume(t: Tracked, chunk: Buffer): void {
    const combined = t.partial.length > 0 ? Buffer.concat([t.partial, chunk]) : chunk;
    const lastNl = combined.lastIndexOf(NL);
    if (lastNl === -1) {
      t.partial = Buffer.from(combined);
      return;
    }
    const text = combined.subarray(0, lastNl).toString('utf8');
    t.partial = Buffer.from(combined.subarray(lastNl + 1));
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      const rec = parseRolloutLine(line);
      if (rec) this.processRecord(t, rec);
    }
  }

  private processRecord(t: Tracked, rec: RolloutLine): void {
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
    if (Number.isFinite(ts)) t.lastRecordAt = ts;
    const pl = rec.payload && typeof rec.payload === 'object' ? (rec.payload as Record<string, unknown>) : undefined;
    switch (rec.type) {
      case 'session_meta': {
        if (!pl) break;
        const id =
          (typeof pl.id === 'string' && pl.id) || (typeof pl.session_id === 'string' && pl.session_id) || undefined;
        if (id) t.sessionId = id;
        if (typeof pl.cwd === 'string') t.cwd = pl.cwd;
        const git = pl.git && typeof pl.git === 'object' ? (pl.git as Record<string, unknown>) : undefined;
        if (git && typeof git.branch === 'string') t.gitBranch = git.branch;
        if (Number.isFinite(ts)) t.startedAt = ts;
        break;
      }
      case 'turn_context': {
        if (!pl) break;
        if (typeof pl.cwd === 'string') t.cwd = pl.cwd;
        if (typeof pl.model === 'string') t.model = pl.model;
        if (typeof pl.effort === 'string') t.effort = pl.effort;
        break;
      }
      case 'event_msg': {
        if (!pl || typeof pl.type !== 'string') break;
        const next = reduceCodexState(t.state, pl.type);
        if (next) t.state = next;
        if (pl.type === 'token_count') {
          const info = pl.info && typeof pl.info === 'object' ? (pl.info as Record<string, unknown>) : undefined;
          if (info) {
            if (typeof info.model_context_window === 'number' && info.model_context_window > 0) {
              t.contextWindow = info.model_context_window;
            }
            const last =
              info.last_token_usage && typeof info.last_token_usage === 'object'
                ? (info.last_token_usage as Record<string, unknown>)
                : undefined;
            if (last && typeof last.input_tokens === 'number' && last.input_tokens > 0) {
              t.contextTokens = last.input_tokens;
            }
          }
        } else if (pl.type === 'agent_message') {
          if (typeof pl.message === 'string' && pl.message.length > 0) {
            t.lastAssistant = pl.message;
            t.recentReplies.push(pl.message);
            if (t.recentReplies.length > RECENT_REPLIES_MAX) {
              t.recentReplies.splice(0, t.recentReplies.length - RECENT_REPLIES_MAX);
            }
          }
        } else if (pl.type === 'user_message') {
          if (typeof pl.message === 'string' && pl.message.length > 0) t.lastPrompt = pl.message;
        }
        break;
      }
    }
  }

  private emit(t: Tracked): void {
    const sink = this.sink;
    if (!sink || !t.sessionId) return;
    const patch: ProviderPatch = { lastActivityAt: t.lastRecordAt ?? this.now() };
    if (t.cwd) {
      patch.cwd = t.cwd;
      patch.project = basename(t.cwd);
      patch.name = basename(t.cwd);
    }
    if (t.gitBranch) patch.gitBranch = t.gitBranch;
    if (t.model) patch.model = t.model;
    if (t.effort) {
      patch.effort = t.effort;
      patch.effortSource = 'hook';
    }
    if (t.startedAt) patch.startedAt = t.startedAt;
    const lp = truncateContext(t.lastPrompt, this.cfg);
    if (lp !== undefined) patch.lastPrompt = lp;
    const sm = truncateContext(t.lastAssistant, this.cfg);
    if (sm !== undefined) patch.lastAssistantSummary = sm;
    if (t.recentReplies.length > 0) patch.recentReplies = t.recentReplies.map((r) => truncateContext(r, this.cfg) ?? r);
    if (t.contextTokens !== undefined) patch.contextTokens = t.contextTokens;
    if (t.contextWindow !== undefined) patch.contextWindow = t.contextWindow;
    sink.patch(t.sessionId, patch);
    if (t.state === 'DEAD') {
      if (!t.emittedDead) {
        sink.markDead(t.sessionId);
        t.emittedDead = true;
      }
    } else if (t.state) {
      sink.setState(t.sessionId, t.state);
    }
  }

  /** 兜底：WORKING 态长时间无写入 → 进程疑似被杀，判 DEAD（等待用户的状态不判死）。 */
  private sweep(): void {
    const sink = this.sink;
    if (!sink) return;
    const now = this.now();
    for (const t of this.tracked.values()) {
      if (!t.sessionId || t.emittedDead) continue;
      if (t.state === 'WORKING' && now - t.mtimeMs > WORKING_DEAD_MS) {
        sink.markDead(t.sessionId);
        t.emittedDead = true;
      }
    }
  }
}

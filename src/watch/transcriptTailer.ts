/**
 * transcriptTailer.ts — 增量 tail ~/.claude/projects/<slug>/<sessionId>.jsonl。
 *
 * 不监听整棵 projects/ 树的语义流量：manager 通过 track()/untrack() 告知哪些
 * 会话存活；本模块只对这些会话的 transcript 做增量尾读，抽取「末尾标记」
 * (TranscriptMarkers) 并回调 onMarkers。绝不把 transcript 全文推给上层。
 *
 * 设计要点：
 *   - 单个 chokidar watcher 挂在 cfg.projectsDir（depth 2，ignoreInitial），
 *     只对属于 tracked 会话的 .jsonl 变更触发增量读。
 *   - 每文件维护字节 offset；size < offset 视为截断/轮转 → 归零重扫。
 *   - track() 时只读文件末尾 ~64KB 做 bootstrap，避免解析上千条记录。
 *   - 以字节为单位保留跨读的行尾残片，避免多字节 UTF-8 在 chunk 边界被截断。
 *   - 事件处理器绝不抛出。
 */

import { open, stat, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { Stats } from 'node:fs';
import type { Config, TranscriptMarkers, Watcher, PermissionMode } from '../types.ts';
import { truncateContext, isSecretPath } from '../config.ts';

/** bootstrap 时只读文件末尾这么多字节。 */
const BOOTSTRAP_TAIL_BYTES = 64 * 1024;
/** 换行字节。 */
const NL = 0x0a;

/** 每个被跟踪会话的尾读状态 + 累积的标记（原始值，emit 时才截断）。 */
interface Tracked {
  cwd: string; // track() 传入的权威 cwd（记录里若有则优先用记录的）
  path: string | undefined; // 已解析的 transcript 绝对路径
  offset: number; // 已消费到的字节偏移
  partial: Buffer; // 上次读到的、末尾未成行的残余字节
  chain: Promise<void>; // 串行化队列：同会话的读操作依次执行，绝不并发

  // —— 累积的标记原始值（latest-wins，按文件顺序覆盖） ——
  recordCwd?: string;
  gitBranch?: string;
  title?: string;
  lastPrompt?: string;
  assistantSummary?: string;
  model?: string;
  permissionMode?: PermissionMode;
  lastStopReason?: string;
  turnDoneMarkerAt?: number;
  lastRecordAt?: number;
}

export interface TranscriptTailerOptions {
  onMarkers: (m: TranscriptMarkers) => void;
  now?: () => number;
}

/** cwd → transcript 目录 slug：把 '/'、'.'、'_' 都替换成 '-'（实测规则，LOSSY，不可反推）。 */
export function slugFromCwd(cwd: string): string {
  return cwd.replace(/[/._]/g, '-');
}

export class TranscriptTailer implements Watcher {
  private readonly cfg: Config;
  private readonly onMarkers: (m: TranscriptMarkers) => void;
  private readonly now: () => number;
  private readonly tracked: Map<string, Tracked>;
  private watcher: FSWatcher | undefined;

  constructor(cfg: Config, opts: TranscriptTailerOptions) {
    this.cfg = cfg;
    this.onMarkers = opts.onMarkers;
    this.now = opts.now ?? (() => Date.now());
    this.tracked = new Map();
    this.watcher = undefined;
  }

  // ── Watcher 生命周期 ────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.watcher) return;
    // chokidar v4 无 glob：监听 projectsDir 本身，depth 2 覆盖 <slug>/<file>。
    // ignored 只在能确定是「非 .jsonl 文件」时才忽略；目录一律放行以便下钻。
    this.watcher = chokidar.watch(this.cfg.projectsDir, {
      ignoreInitial: true,
      depth: 2,
      ignored: (p: string, stats?: Stats) => {
        if (stats?.isFile()) return !p.endsWith('.jsonl');
        return false;
      },
    });
    this.watcher
      .on('add', (p) => this.handleFsEvent(p))
      .on('change', (p) => this.handleFsEvent(p));

    await new Promise<void>((resolve) => {
      this.watcher!.on('ready', () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = undefined;
    }
  }

  // ── 会话跟踪 ───────────────────────────────────────────────────────────

  /** 开始尾读该会话的 transcript。同步登记，异步做 bootstrap（不抛出）。 */
  track(sessionId: string, cwd: string): void {
    const existing = this.tracked.get(sessionId);
    if (existing) {
      // 已在跟踪：仅更新 cwd（用于路径回退解析）。
      existing.cwd = cwd;
      return;
    }
    const t: Tracked = {
      cwd,
      path: undefined,
      offset: 0,
      partial: Buffer.alloc(0),
      chain: Promise.resolve(),
    };
    this.tracked.set(sessionId, t);
    void this.enqueue(sessionId, () => this.bootstrapRead(sessionId));
  }

  /** 停止尾读该会话。 */
  untrack(sessionId: string): void {
    this.tracked.delete(sessionId);
  }

  /** 增量尾读一次（chokidar 处理器与测试共用的可测试入口）。 */
  async refresh(sessionId: string): Promise<void> {
    await this.enqueue(sessionId, () => this.readIncremental(sessionId));
  }

  // ── 内部 ───────────────────────────────────────────────────────────────

  /** chokidar 事件入口：定位所属会话并触发增量读。绝不抛出。 */
  private handleFsEvent(path: string): void {
    if (isSecretPath(path)) return;
    if (!path.endsWith('.jsonl')) return;
    const sid = basename(path, '.jsonl');
    const t = this.tracked.get(sid);
    if (!t) return;
    if (t.path === undefined) t.path = path; // 之前不存在，现在文件已出现
    void this.enqueue(sid, () => this.readIncremental(sid));
  }

  /**
   * 串行化队列：把 fn 追加到该会话的 promise 链尾，保证同会话读操作按序执行、
   * 绝不并发。返回的 promise 在 fn 自身完成后 resolve（便于测试 await）。
   * fn 内的任何错误都被吞掉：事件处理器绝不抛出。
   */
  private enqueue(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const t = this.tracked.get(sessionId);
    if (!t) return Promise.resolve();
    const run = t.chain.then(async () => {
      if (!this.tracked.has(sessionId)) return; // 期间被 untrack
      try {
        await fn();
      } catch {
        // 读/解析/回调异常一律吞掉。
      }
    });
    // 链本身用 catch 兜底，避免未处理拒绝（理论上 run 已吞错，双保险）。
    t.chain = run.catch(() => undefined);
    return run;
  }

  /** 解析 slug 猜测路径；找不到则扫描 projectsDir 各子目录寻找 <sessionId>.jsonl。 */
  private async resolvePath(sessionId: string, cwd: string): Promise<string | undefined> {
    const fileName = `${sessionId}.jsonl`;
    // 1) slug 猜测
    const guess = join(this.cfg.projectsDir, slugFromCwd(cwd), fileName);
    try {
      await stat(guess);
      return guess;
    } catch {
      // 猜测未命中，进入回退扫描。
    }
    // 2) 回退：readdir projectsDir，逐个子目录探测文件是否存在。
    let entries: string[];
    try {
      entries = await readdir(this.cfg.projectsDir);
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const candidate = join(this.cfg.projectsDir, entry, fileName);
      try {
        await stat(candidate);
        return candidate;
      } catch {
        // 该子目录无此文件，继续。
      }
    }
    return undefined;
  }

  /** bootstrap：读末尾 ~64KB，抽取标记，然后把 offset 设到 EOF。 */
  private async bootstrapRead(sessionId: string): Promise<void> {
    const t = this.tracked.get(sessionId);
    if (!t) return;
    if (t.path === undefined) t.path = await this.resolvePath(sessionId, t.cwd);
    if (t.path === undefined) return; // 文件尚未出现，后续事件会重试

    let st: Stats;
    try {
      st = await stat(t.path);
    } catch {
      t.path = undefined; // 可能被删/移动，下次重解析
      return;
    }
    const size = st.size;
    const start = Math.max(0, size - BOOTSTRAP_TAIL_BYTES);
    const len = size - start;
    if (len > 0) {
      const fh = await open(t.path, 'r');
      try {
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, start);
        // 若从文件中段起读，首行可能是残片 → 丢弃到首个换行之后。
        let region = buf;
        if (start > 0) {
          const first = buf.indexOf(NL);
          region = first === -1 ? Buffer.alloc(0) : buf.subarray(first + 1);
        }
        this.consume(t, region);
      } finally {
        await fh.close();
      }
    }
    t.offset = size;
    this.emit(sessionId, t);
  }

  /** 增量读：从 offset 到 EOF；size < offset 视为截断 → 归零重扫。 */
  private async readIncremental(sessionId: string): Promise<void> {
    const t = this.tracked.get(sessionId);
    if (!t) return;
    if (t.path === undefined) t.path = await this.resolvePath(sessionId, t.cwd);
    if (t.path === undefined) return;

    let st: Stats;
    try {
      st = await stat(t.path);
    } catch {
      return; // 文件暂时不可读，下次事件重试
    }
    const size = st.size;
    if (size < t.offset) {
      // 截断/轮转：重置偏移与残片，清空累积标记，从头重扫。
      t.offset = 0;
      t.partial = Buffer.alloc(0);
      this.resetMarkers(t);
    }
    if (size === t.offset) return; // 无新增字节

    const len = size - t.offset;
    const fh = await open(t.path, 'r');
    let processed = false;
    try {
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, t.offset);
      processed = this.consume(t, buf);
    } finally {
      await fh.close();
    }
    t.offset = size;
    if (processed) this.emit(sessionId, t);
  }

  /**
   * 把一段新字节并入残片，按换行切出「完整区段」解析，末尾未成行的字节留作残片。
   * 以换行为清晰边界解码，避免多字节 UTF-8 在 chunk 边界被截断。
   * 返回是否至少解析了一条记录。
   */
  private consume(t: Tracked, chunk: Buffer): boolean {
    const combined = t.partial.length > 0 ? Buffer.concat([t.partial, chunk]) : chunk;
    const lastNl = combined.lastIndexOf(NL);
    if (lastNl === -1) {
      // 没有完整行：整段留作残片。
      t.partial = Buffer.from(combined);
      return false;
    }
    const completeText = combined.subarray(0, lastNl).toString('utf8');
    t.partial = Buffer.from(combined.subarray(lastNl + 1));
    let processed = false;
    for (const line of completeText.split('\n')) {
      if (line.trim().length === 0) continue;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // 半写/损坏行，跳过
      }
      this.processRecord(t, rec);
      processed = true;
    }
    return processed;
  }

  /** 用一条已解析记录更新累积标记（latest-wins）。 */
  private processRecord(t: Tracked, rec: unknown): void {
    if (rec === null || typeof rec !== 'object') return;
    const r = rec as Record<string, unknown>;
    const type = r.type;

    // 时间戳（ISO8601 → epoch ms）。
    const rawTs = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
    const tsMs = Number.isFinite(rawTs) ? rawTs : undefined;
    if (tsMs !== undefined) t.lastRecordAt = tsMs;

    // 任何带 cwd/gitBranch 的记录都更新（latest-wins）。
    if (typeof r.cwd === 'string' && r.cwd.length > 0) t.recordCwd = r.cwd;
    if (typeof r.gitBranch === 'string' && r.gitBranch.length > 0) t.gitBranch = r.gitBranch;

    switch (type) {
      case 'ai-title': {
        if (typeof r.aiTitle === 'string') t.title = r.aiTitle;
        break;
      }
      case 'last-prompt': {
        if (typeof r.lastPrompt === 'string') t.lastPrompt = r.lastPrompt;
        break;
      }
      case 'permission-mode': {
        if (typeof r.permissionMode === 'string') t.permissionMode = r.permissionMode as PermissionMode;
        break;
      }
      case 'assistant': {
        const message = r.message;
        if (message !== null && typeof message === 'object') {
          const m = message as Record<string, unknown>;
          if (typeof m.model === 'string') t.model = m.model;
          if (typeof m.stop_reason === 'string') t.lastStopReason = m.stop_reason;
          const content = m.content;
          if (Array.isArray(content)) {
            const texts: string[] = [];
            for (const block of content) {
              if (block !== null && typeof block === 'object') {
                const b = block as Record<string, unknown>;
                if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
              }
            }
            if (texts.length > 0) t.assistantSummary = texts.join('\n');
          }
          if (m.stop_reason === 'end_turn') t.turnDoneMarkerAt = tsMs ?? this.now();
        }
        break;
      }
      case 'system': {
        const subtype = r.subtype;
        if (subtype === 'away_summary') {
          if (typeof r.content === 'string') t.assistantSummary = r.content;
          t.turnDoneMarkerAt = tsMs ?? this.now();
        } else if (subtype === 'turn_duration') {
          t.turnDoneMarkerAt = tsMs ?? this.now();
        }
        break;
      }
      default:
        break;
    }
  }

  /** 截断/轮转时清空累积标记（保留 track 传入的 cwd）。 */
  private resetMarkers(t: Tracked): void {
    t.recordCwd = undefined;
    t.gitBranch = undefined;
    t.title = undefined;
    t.lastPrompt = undefined;
    t.assistantSummary = undefined;
    t.model = undefined;
    t.permissionMode = undefined;
    t.lastStopReason = undefined;
    t.turnDoneMarkerAt = undefined;
    t.lastRecordAt = undefined;
  }

  /** 由累积状态构造对外的 TranscriptMarkers（在此处截断上下文字段），并回调。 */
  private emit(sessionId: string, t: Tracked): void {
    const m: TranscriptMarkers = { sessionId };

    const cwd = t.recordCwd ?? t.cwd;
    if (cwd.length > 0) m.cwd = cwd;
    if (t.gitBranch !== undefined) m.gitBranch = t.gitBranch;

    const title = truncateContext(t.title, this.cfg);
    if (title !== undefined) m.currentTitle = title;
    const lastPrompt = truncateContext(t.lastPrompt, this.cfg);
    if (lastPrompt !== undefined) m.lastPrompt = lastPrompt;
    const summary = truncateContext(t.assistantSummary, this.cfg);
    if (summary !== undefined) m.lastAssistantSummary = summary;

    if (t.model !== undefined) m.model = t.model;
    if (t.permissionMode !== undefined) m.permissionMode = t.permissionMode;
    if (t.lastStopReason !== undefined) m.lastStopReason = t.lastStopReason;
    if (t.turnDoneMarkerAt !== undefined) m.turnDoneMarkerAt = t.turnDoneMarkerAt;
    if (t.lastRecordAt !== undefined) m.lastRecordAt = t.lastRecordAt;

    this.onMarkers(m);
  }
}

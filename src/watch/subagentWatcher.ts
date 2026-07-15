/**
 * subagentWatcher.ts — 子代理 token 足迹 + workflow 活动采集（合二为一）。
 *
 * 一个 sweep 定时器，一趟遍历 <slug>/<sessionId>/subagents/** 同时算出：
 *   - token 足迹：Σ 每个 agent-*.jsonl 的 peak(usage 四项和) —— 累计算力消耗，非当前上下文
 *   - workflow 活动：wf_* 目录数、内部 agent 数、最近活动时间
 *
 * 二者都是纯展示遥测，manager 直接 upsert 不进 reconcile。跨 slug 按 sessionId 合并
 * （sessionId = 目录第 2 段名，枚举全 slug 探同名 subagents）。
 *
 * 性能：只扫存活会话；mtime+size 跳过未变文件（死会话零读）；wf agent 列表按 dir mtime
 * 缓存；跨-slug 目录 30s 缓存；签名去抖不 emit。绝不每秒全量重解析。
 */

import { open, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Stats } from 'node:fs';
import type { Config, Watcher, SubagentStats } from '../types.ts';
import { computeContextTokens, slugFromCwd } from './transcriptTailer.ts';

const SWEEP_INTERVAL_MS = 5_000;
const ACTIVE_WINDOW_MS = 90_000;
const SLUGDIRS_TTL_MS = 30_000;
const BOOTSTRAP_MAX_BYTES = 4 * 1024 * 1024; // >4MB 只读末 2MB bootstrap
const BOOTSTRAP_TAIL_BYTES = 2 * 1024 * 1024;
const NL = 0x0a;

interface FileState {
  offset: number;
  partial: Buffer;
  peak: number;
  mtimeMs: number;
  size: number;
}
interface WfDirState {
  dirMtimeMs: number;
  agentPaths: string[]; // dir mtime 未变则复用，不重新 readdir
}

interface TrackedSession {
  cwd: string;
  slugDirs: string[];
  slugDirsAt: number;
  files: Map<string, FileState>; // key = agent-*.jsonl 绝对路径（天然去重）
  wfDirs: Map<string, WfDirState>; // key = wf_<id> 名（跨-slug 去重）
  lastSig: string;
  chain: Promise<void>;
}

export interface SubagentWatcherOptions {
  onStats: (s: SubagentStats) => void;
  now?: () => number;
  sweepIntervalMs?: number;
  activeWindowMs?: number;
}

export class SubagentWatcher implements Watcher {
  private readonly cfg: Config;
  private readonly onStats: (s: SubagentStats) => void;
  private readonly now: () => number;
  private readonly sweepIntervalMs: number;
  private readonly activeWindowMs: number;
  private readonly tracked = new Map<string, TrackedSession>();
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(cfg: Config, opts: SubagentWatcherOptions) {
    this.cfg = cfg;
    this.onStats = opts.onStats;
    this.now = opts.now ?? (() => Date.now());
    this.sweepIntervalMs = opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    this.activeWindowMs = opts.activeWindowMs ?? ACTIVE_WINDOW_MS;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweepAll(), this.sweepIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  track(sessionId: string, cwd: string): void {
    const existing = this.tracked.get(sessionId);
    if (existing) {
      existing.cwd = cwd;
      return;
    }
    this.tracked.set(sessionId, {
      cwd,
      slugDirs: [],
      slugDirsAt: 0,
      files: new Map(),
      wfDirs: new Map(),
      lastSig: '',
      chain: Promise.resolve(),
    });
    void this.enqueue(sessionId, () => this.sweepSession(sessionId)); // 立即 bootstrap 一次
  }

  untrack(sessionId: string): void {
    this.tracked.delete(sessionId);
  }

  /** 测试可直接驱动的入口。 */
  async refresh(sessionId: string): Promise<void> {
    await this.enqueue(sessionId, () => this.sweepSession(sessionId));
  }

  private enqueue(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const t = this.tracked.get(sessionId);
    if (!t) return Promise.resolve();
    const run = t.chain.then(async () => {
      if (!this.tracked.has(sessionId)) return;
      try {
        await fn();
      } catch {
        /* 处理器绝不抛出 */
      }
    });
    t.chain = run.catch(() => undefined);
    return run;
  }

  private async sweepAll(): Promise<void> {
    if (this.busy) return; // 防重入
    this.busy = true;
    try {
      for (const sid of [...this.tracked.keys()]) {
        await this.enqueue(sid, () => this.sweepSession(sid));
      }
    } finally {
      this.busy = false;
    }
  }

  /** 跨-slug 目录解析（低频缓存）：找出所有 <slug>/<sid>/subagents 绝对路径。 */
  private async resolveSlugDirs(sessionId: string, t: TrackedSession): Promise<void> {
    if (this.now() - t.slugDirsAt < SLUGDIRS_TTL_MS && t.slugDirs.length > 0) return;
    const dirs: string[] = [];
    if (t.cwd) {
      const primary = join(this.cfg.projectsDir, slugFromCwd(t.cwd), sessionId, 'subagents');
      try {
        if ((await stat(primary)).isDirectory()) dirs.push(primary);
      } catch {
        /* 不存在 */
      }
    }
    let slugs: string[] = [];
    try {
      slugs = await readdir(this.cfg.projectsDir);
    } catch {
      /* ignore */
    }
    for (const slug of slugs) {
      const d = join(this.cfg.projectsDir, slug, sessionId, 'subagents');
      if (dirs.includes(d)) continue;
      try {
        if ((await stat(d)).isDirectory()) dirs.push(d);
      } catch {
        /* 无 */
      }
    }
    t.slugDirs = dirs;
    t.slugDirsAt = this.now();
  }

  /** 一次 sweep：一趟遍历同时算 token 足迹 + workflow 活动。 */
  private async sweepSession(sessionId: string): Promise<void> {
    const t = this.tracked.get(sessionId);
    if (!t) return;
    await this.resolveSlugDirs(sessionId, t);

    const seenFiles = new Set<string>(); // 全部 agent-*.jsonl（token + agentCount）
    const seenWf = new Map<string, number>(); // wf_<id> → 内部 agent 数（去重）
    let lastWorkflowAt = 0;

    for (const subDir of t.slugDirs) {
      let entries;
      try {
        entries = await readdir(subDir, { withFileTypes: true });
      } catch {
        continue; // ENOENT 跳过
      }
      for (const e of entries) {
        if (e.isFile() && e.name.startsWith('agent-') && e.name.endsWith('.jsonl')) {
          seenFiles.add(join(subDir, e.name)); // 顶层子代理
        } else if (e.isDirectory() && e.name === 'workflows') {
          const wfRoot = join(subDir, 'workflows');
          let wfs;
          try {
            wfs = await readdir(wfRoot, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const w of wfs) {
            if (!(w.isDirectory() && w.name.startsWith('wf_'))) continue; // 过滤 scripts/
            const wfPath = join(wfRoot, w.name);
            let dst: Stats;
            try {
              dst = await stat(wfPath);
            } catch {
              continue;
            }
            lastWorkflowAt = Math.max(lastWorkflowAt, dst.mtimeMs);
            try {
              lastWorkflowAt = Math.max(lastWorkflowAt, (await stat(join(wfPath, 'journal.jsonl'))).mtimeMs);
            } catch {
              /* 无 journal */
            }
            // agent 列表：dir mtime 未变则复用缓存。
            const cached = t.wfDirs.get(w.name);
            let agentPaths: string[];
            if (cached && cached.dirMtimeMs === dst.mtimeMs) {
              agentPaths = cached.agentPaths;
            } else {
              let inner: string[] = [];
              try {
                inner = await readdir(wfPath);
              } catch {
                inner = [];
              }
              agentPaths = inner
                .filter((n) => n.startsWith('agent-') && n.endsWith('.jsonl'))
                .map((n) => join(wfPath, n));
              t.wfDirs.set(w.name, { dirMtimeMs: dst.mtimeMs, agentPaths });
            }
            seenWf.set(w.name, agentPaths.length);
            for (const p of agentPaths) seenFiles.add(p);
          }
        }
      }
    }

    // 清理已消失的文件/wf 缓存。
    for (const key of [...t.files.keys()]) if (!seenFiles.has(key)) t.files.delete(key);
    for (const key of [...t.wfDirs.keys()]) if (!seenWf.has(key)) t.wfDirs.delete(key);

    // 逐文件读取 peak（mtime+size 未变则跳过）。
    for (const path of seenFiles) {
      await this.updateFilePeak(t, path);
    }

    // 汇总。
    let subagentTokens = 0;
    for (const p of seenFiles) {
      const fs = t.files.get(p);
      if (fs) subagentTokens += fs.peak;
    }
    const agentCount = seenFiles.size;
    const workflowCount = seenWf.size;
    let workflowAgentCount = 0;
    for (const n of seenWf.values()) workflowAgentCount += n;
    const workflowActive = lastWorkflowAt > 0 && this.now() - lastWorkflowAt < this.activeWindowMs;

    // 签名去抖：无变化不 emit。
    const sig = `${subagentTokens}:${agentCount}:${workflowCount}:${workflowAgentCount}:${lastWorkflowAt}:${workflowActive}`;
    if (sig === t.lastSig) return;
    t.lastSig = sig;

    const stats: SubagentStats = {
      sessionId,
      subagentTokens,
      agentCount,
      workflowCount,
      workflowAgentCount,
      workflowActive,
    };
    if (lastWorkflowAt > 0) stats.lastWorkflowAt = lastWorkflowAt;
    this.onStats(stats);
  }

  /**
   * 更新单个 agent 文件的 peak（usage 四项和的运行期最大值）。
   * mtime+size 未变则跳过（死会话零读）；size < offset 视为截断 → 归零重扫。
   * peak 取 max 免疫 synthetic-0 收尾记录与远离文件尾的真实末条。
   */
  private async updateFilePeak(t: TrackedSession, path: string): Promise<void> {
    let st: Stats;
    try {
      st = await stat(path);
    } catch {
      return; // 文件消失，下次清理
    }
    let fs = t.files.get(path);
    if (fs && fs.mtimeMs === st.mtimeMs && fs.size === st.size) return; // 未变，跳过

    if (!fs) {
      fs = { offset: 0, partial: Buffer.alloc(0), peak: 0, mtimeMs: 0, size: 0 };
      t.files.set(path, fs);
      // 大文件 bootstrap：只读末 2MB（peak 在其中，因上下文单调增长）。
      if (st.size > BOOTSTRAP_MAX_BYTES) {
        fs.offset = st.size - BOOTSTRAP_TAIL_BYTES;
      }
    }
    if (st.size < fs.offset) {
      // 截断/轮转：归零重扫。
      fs.offset = 0;
      fs.partial = Buffer.alloc(0);
      fs.peak = 0;
    }
    if (st.size === fs.offset) {
      fs.mtimeMs = st.mtimeMs;
      fs.size = st.size;
      return;
    }

    const len = st.size - fs.offset;
    let fh;
    try {
      fh = await open(path, 'r');
    } catch {
      return;
    }
    try {
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, fs.offset);
      let region = buf;
      // bootstrap 从中段起读，首行可能是残片 → 丢到首个换行后。
      if (fs.offset > 0 && fs.partial.length === 0) {
        const first = buf.indexOf(NL);
        region = first === -1 ? Buffer.alloc(0) : buf.subarray(first + 1);
      }
      const combined = fs.partial.length > 0 ? Buffer.concat([fs.partial, region]) : region;
      const lastNl = combined.lastIndexOf(NL);
      if (lastNl === -1) {
        fs.partial = Buffer.from(combined);
      } else {
        const text = combined.subarray(0, lastNl).toString('utf8');
        fs.partial = Buffer.from(combined.subarray(lastNl + 1));
        for (const line of text.split('\n')) {
          if (!line.includes('usage')) continue; // 便宜预筛
          let rec: Record<string, unknown>;
          try {
            rec = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          const msg = rec.message;
          if (msg === null || typeof msg !== 'object') continue;
          const ct = computeContextTokens((msg as Record<string, unknown>).usage);
          if (ct !== undefined && ct > fs.peak) fs.peak = ct; // 运行期 max
        }
      }
    } finally {
      await fh.close();
    }
    fs.offset = st.size;
    fs.mtimeMs = st.mtimeMs;
    fs.size = st.size;
  }
}

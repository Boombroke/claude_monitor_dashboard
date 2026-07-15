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
  recentReplies: string[]; // 最近 N 条助手回复文本（旧→新，环形）
  model?: string;
  permissionMode?: PermissionMode;
  lastStopReason?: string;
  turnDoneMarkerAt?: number;
  lastRecordAt?: number;
  contextTokens?: number; // 最新主链 assistant usage 四项之和 = 当前上下文占用
  effortEcho?: string; // 主链末次 /effort 回显的档名（ultracode/xhigh/max/…）
  echoScanned?: boolean; // 是否已做过一次性全文回填扫描
}

/** /effort 命令回显文本的短语锚点（用于快速字节查找）。 */
const EFFORT_ECHO_PHRASE = 'Set effort level to ';

/**
 * 从一条记录里提取主链 /effort 回显档名。
 * 形态：{type:"user", isSidechain!==true, message.content 为字符串且含 "Set effort level to X"}。
 * 子代理/tool-result 里的假回显（message.content 是数组）天然被排除。
 * 返回档名（小写原样，如 "ultracode"/"xhigh"/"max"）或 undefined。
 */
export function extractEffortEcho(rec: unknown): string | undefined {
  if (rec === null || typeof rec !== 'object') return undefined;
  const r = rec as Record<string, unknown>;
  if (r.type !== 'user' || r.isSidechain === true) return undefined;
  const msg = r.message;
  if (msg === null || typeof msg !== 'object') return undefined;
  const content = (msg as Record<string, unknown>).content;
  if (typeof content !== 'string') return undefined;
  if (!content.includes(EFFORT_ECHO_PHRASE)) return undefined;
  const m = content.match(/Set effort level to (\w+)/);
  return m && m[1] ? m[1].toLowerCase() : undefined;
}

/** 保留最近多少条助手回复。 */
const RECENT_REPLIES_MAX = 5;

export interface TranscriptTailerOptions {
  onMarkers: (m: TranscriptMarkers) => void;
  now?: () => number;
}

/** cwd → transcript 目录 slug：把 '/'、'.'、'_' 都替换成 '-'（实测规则，LOSSY，不可反推）。 */
export function slugFromCwd(cwd: string): string {
  return cwd.replace(/[/._]/g, '-');
}

const WINDOW_200K = 200_000;
const WINDOW_1M = 1_000_000;

/**
 * 从 assistant.message.usage 求当前上下文占用 token：四项之和。
 * 缺字段/负数/非有限按 0；非对象或全 0 → undefined（未知）。
 */
export function computeContextTokens(usage: unknown): number | undefined {
  if (usage === null || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const total =
    n(u.input_tokens) +
    n(u.cache_creation_input_tokens) +
    n(u.cache_read_input_tokens) +
    n(u.output_tokens);
  return total > 0 ? total : undefined;
}

/** 已知原生 1M 上下文窗口的模型族（Claude 5 家族 / Opus 4.8）。 */
function isNative1M(model: string): boolean {
  const m = model.toLowerCase();
  return (
    m.includes('opus-4-8') ||
    m.includes('sonnet-5') ||
    m.includes('sonnet-4-6') ||
    m.includes('fable-5') ||
    m.includes('haiku-4-5')
  );
}

/**
 * 推断上下文窗口大小（无直接字段）。优先级：
 *   1. 模型名含 [1m] 部署标记 → 1M
 *   2. 已知原生 1M 模型族 → 1M（让刚开、token 还少的会话也判准）
 *   3. 实测 token > 200K → 必是 1M
 *   4. 其余（未知模型/旧 200K 模型）→ 200K
 * 保证正常情况 tokens ≤ 窗口，避免百分比 > 100%。
 */
export function inferContextWindow(model: string | undefined, contextTokens: number | undefined): number {
  if (model && /\[1m\]/i.test(model)) return WINDOW_1M;
  if (model && isNative1M(model)) return WINDOW_1M;
  if (contextTokens !== undefined && contextTokens > WINDOW_200K) return WINDOW_1M;
  return WINDOW_200K;
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
      recentReplies: [],
    };
    this.tracked.set(sessionId, t);
    void this.enqueue(sessionId, () => this.bootstrapRead(sessionId));
    // 一次性全文回填 /effort 回显：echo 可能距文件尾很远（实测数 MB），
    // 64KB bootstrap 会漏采存量会话，故做定向字节扫描补回。
    void this.enqueue(sessionId, () => this.scanEffortEcho(sessionId));
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

  /**
   * 一次性全文扫描，回填主链末次 /effort 回显（bootstrap 64KB 会漏采远离尾部的 echo）。
   * 用带重叠的分块字节查找短语，仅对命中短语的行做 JSON.parse——避免逐行解析整个大文件。
   * 只跑一次（echoScanned 标记）；增量路径之后免费捕获新的 echo。
   */
  private async scanEffortEcho(sessionId: string): Promise<void> {
    const t = this.tracked.get(sessionId);
    if (!t || t.echoScanned) return;
    if (t.path === undefined) t.path = await this.resolvePath(sessionId, t.cwd);
    if (t.path === undefined) return; // 文件未出现，下次 track/事件再试（不置 scanned）
    t.echoScanned = true;

    const CHUNK = 1 << 20; // 1MB
    const OVERLAP = 4096; // 覆盖跨块边界的行
    let fh;
    try {
      fh = await open(t.path, 'r');
    } catch {
      return;
    }
    try {
      const st = await fh.stat();
      const size = st.size;
      let pos = 0;
      let carry = Buffer.alloc(0); // 上一块末尾未成行的残片
      let lastEcho: string | undefined;
      while (pos < size) {
        const len = Math.min(CHUNK, size - pos);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, pos);
        pos += len;
        const combined = carry.length > 0 ? Buffer.concat([carry, buf]) : buf;
        // 只在含短语时才切行解析。
        if (combined.includes(EFFORT_ECHO_PHRASE)) {
          const lastNl = combined.lastIndexOf(NL);
          const text = (lastNl === -1 ? combined : combined.subarray(0, lastNl)).toString('utf8');
          for (const line of text.split('\n')) {
            if (!line.includes(EFFORT_ECHO_PHRASE)) continue;
            try {
              const echo = extractEffortEcho(JSON.parse(line));
              if (echo !== undefined) lastEcho = echo; // latest-wins
            } catch {
              /* 半行/损坏，跳过 */
            }
          }
        }
        // 留末尾 OVERLAP 字节作 carry，防止行被块边界截断。
        carry = combined.length > OVERLAP ? Buffer.from(combined.subarray(combined.length - OVERLAP)) : combined;
      }
      // 仅当增量尚未捕获到更新的 echo 时才回填（不覆盖已有值）。
      if (lastEcho !== undefined && t.effortEcho === undefined) {
        t.effortEcho = lastEcho;
        this.emit(sessionId, t);
      }
    } catch {
      /* 扫描失败：忽略，增量路径仍可捕获后续 echo */
    } finally {
      await fh.close();
    }
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

    // /effort 命令回显（主链 user 记录）：区分 ultracode/xhigh 的唯一可靠信号，latest-wins。
    // 提前拦截并 return，避免这条 user 记录落入下方 assistant/文本处理污染 recentReplies。
    const echo = extractEffortEcho(rec);
    if (echo !== undefined) {
      t.effortEcho = echo;
      return;
    }

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
          // 仅主链(非 sidechain)assistant 代表主线模型与上下文占用；
          // 子代理(Task 工具)的小 usage 不能让主线读数缩水。
          if (r.isSidechain !== true) {
            if (typeof m.model === 'string') t.model = m.model;
            const ct = computeContextTokens(m.usage);
            if (ct !== undefined) t.contextTokens = ct; // latest-wins = 当前占用
          }
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
            if (texts.length > 0) {
              const joined = texts.join('\n');
              t.assistantSummary = joined;
              // 推入最近回复环形缓冲（保留最近 N 条）。
              t.recentReplies.push(joined);
              if (t.recentReplies.length > RECENT_REPLIES_MAX) {
                t.recentReplies.splice(0, t.recentReplies.length - RECENT_REPLIES_MAX);
              }
            }
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
    t.recentReplies = [];
    t.model = undefined;
    t.permissionMode = undefined;
    t.lastStopReason = undefined;
    t.turnDoneMarkerAt = undefined;
    t.lastRecordAt = undefined;
    t.contextTokens = undefined;
    // 注意：不清 effortEcho —— /effort 设定跨 compaction/轮转持续有效，
    // 清掉会在下次 /effort 前丢失 ultracode 状态。
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
    if (t.recentReplies.length > 0) {
      // 每条截断（略放宽长度，便于看清"到哪一步"）。
      m.recentReplies = t.recentReplies.map((r) => truncateContext(r, this.cfg) ?? r);
    }

    if (t.model !== undefined) m.model = t.model;
    if (t.contextTokens !== undefined) {
      m.contextTokens = t.contextTokens;
      m.contextWindow = inferContextWindow(t.model, t.contextTokens);
    }
    if (t.permissionMode !== undefined) m.permissionMode = t.permissionMode;
    if (t.effortEcho !== undefined) m.effortEcho = t.effortEcho;
    if (t.lastStopReason !== undefined) m.lastStopReason = t.lastStopReason;
    if (t.turnDoneMarkerAt !== undefined) m.turnDoneMarkerAt = t.turnDoneMarkerAt;
    if (t.lastRecordAt !== undefined) m.lastRecordAt = t.lastRecordAt;

    this.onMarkers(m);
  }
}

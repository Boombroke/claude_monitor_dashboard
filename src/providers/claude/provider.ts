/**
 * providers/claude/provider.ts — Claude Code 监控 provider。
 *
 * 从 manager 迁移而来的 Claude 采集逻辑：自持 sessionsWatcher + transcriptTailer
 * + subagentWatcher + liveness reaper + DefaultReconciler，把各信号汇入 reconciler
 * 并通过 sink 写入内核。全程使用 RAW sessionId（sink 负责复合 key 命名空间）。
 *
 * 每会话维护 ReconcilerInputs 的最新分量；任一分量变化即重算状态。
 * 进入 IDLE/DONE_WAITING 的去抖由内核 sink 统一处理（此处只传 immediate 意图）。
 */

import { basename } from 'node:path';
import type {
  Config,
  HookPayload,
  ReconcilerInputs,
  SessionFileSnapshot,
  SubagentStats,
  TranscriptMarkers,
} from '../../types.ts';
import { DefaultReconciler } from '../../core/reconciler.ts';
import { LivenessReaper } from '../../core/liveness.ts';
import { SessionsWatcher } from '../../watch/sessionsWatcher.ts';
import { TranscriptTailer } from '../../watch/transcriptTailer.ts';
import { SubagentWatcher } from '../../watch/subagentWatcher.ts';
import type { Provider, ProviderPatch, SessionSink } from '../types.ts';

/** 每会话的原始输入缓存（reconcile 的分量来源）。 */
interface RawInputs {
  file?: SessionFileSnapshot;
  markers?: TranscriptMarkers;
  hook?: { payload: HookPayload; at: number };
  deadPid?: number;
}

export interface ClaudeProviderOptions {
  now?: () => number;
}

export class ClaudeProvider implements Provider {
  readonly agent = 'claude' as const;

  private readonly cfg: Config;
  private readonly now: () => number;
  private readonly reconciler: DefaultReconciler;
  private readonly watcher: SessionsWatcher;
  private readonly tailer: TranscriptTailer;
  private readonly subagents: SubagentWatcher;
  private readonly reaper: LivenessReaper;

  private sink: SessionSink | undefined;
  private readonly raw = new Map<string, RawInputs>();
  private readonly trackedSessions = new Set<string>();
  /** pid → sessionId 本地副索引（原 store.getByPid 的 provider 局部替代）。 */
  private readonly pidToSid = new Map<number, string>();

  constructor(cfg: Config, opts: ClaudeProviderOptions = {}) {
    this.cfg = cfg;
    this.now = opts.now ?? Date.now;
    this.reconciler = new DefaultReconciler({ hookTtlMs: cfg.hookTtlMs });
    this.tailer = new TranscriptTailer(cfg, { onMarkers: (m) => this.onMarkers(m) });
    this.subagents = new SubagentWatcher(cfg, { onStats: (s) => this.onSubagentStats(s) });
    this.watcher = new SessionsWatcher(cfg, {
      onUpsert: (snap) => this.onFileSnapshot(snap),
      onRemove: (pid) => this.onFileRemoved(pid),
    });
    this.reaper = new LivenessReaper({
      intervalMs: 5_000,
      deadThreshold: 2,
      getPids: () => this.livePids(),
      onDead: (pid) => this.onPidDead(pid),
    });
  }

  async start(sink: SessionSink): Promise<void> {
    this.sink = sink;
    await this.tailer.start();
    await this.subagents.start();
    await this.watcher.start();
    this.reaper.start();
  }

  async stop(): Promise<void> {
    this.reaper.stop();
    await this.watcher.stop();
    await this.tailer.stop();
    await this.subagents.stop();
  }

  /** POST /hooks 收到的 Claude hook body。 */
  onPush(body: unknown): void {
    this.onHook(body as HookPayload);
  }

  // ——— 信号入口 ———

  /** 来自 sessionsWatcher 的文件快照。 */
  onFileSnapshot(snap: SessionFileSnapshot): void {
    if (!this.sink) return;
    const r = this.rawOf(snap.sessionId);
    r.file = snap;
    r.deadPid = undefined;
    this.pidToSid.set(snap.pid, snap.sessionId);
    this.applyIdentity(snap);
    this.maybeTrack(snap.sessionId, snap.cwd);
    this.recompute(snap.sessionId);
  }

  /** sessions 文件被删（pid 维度）→ 定位会话并判死。 */
  onFileRemoved(pid: number): void {
    const sink = this.sink;
    if (!sink) return;
    const sid = this.pidToSid.get(pid);
    if (!sid) return;
    const s = sink.peek(sid);
    if (s && s.pid === pid) {
      const r = this.rawOf(sid);
      r.deadPid = pid;
      this.recompute(sid, /*immediate*/ true);
    }
  }

  /** 来自 transcriptTailer 的标记。 */
  onMarkers(markers: TranscriptMarkers): void {
    const sink = this.sink;
    if (!sink) return;
    const r = this.rawOf(markers.sessionId);
    r.markers = { ...r.markers, ...markers };
    const patch: ProviderPatch = {};
    if (markers.currentTitle !== undefined) patch.currentTitle = markers.currentTitle;
    if (markers.lastPrompt !== undefined) patch.lastPrompt = markers.lastPrompt;
    if (markers.lastAssistantSummary !== undefined)
      patch.lastAssistantSummary = markers.lastAssistantSummary;
    if (markers.recentReplies !== undefined) patch.recentReplies = markers.recentReplies;
    if (markers.model !== undefined) patch.model = markers.model;
    if (markers.contextTokens !== undefined) patch.contextTokens = markers.contextTokens;
    if (markers.contextWindow !== undefined) patch.contextWindow = markers.contextWindow;
    if (markers.gitBranch !== undefined) patch.gitBranch = markers.gitBranch;
    if (markers.permissionMode !== undefined) patch.permissionMode = markers.permissionMode;
    // /effort 回显：唯一能区分 ultracode 的信号（hook 把 ultracode 报成 xhigh）。
    if (markers.effortEcho !== undefined) {
      patch.ultracode = markers.effortEcho === 'ultracode';
      // effort 档位优先级 hook > echo > default：仅当当前不是 hook 来源时，用 echo 值。
      const cur = sink.peek(markers.sessionId);
      if (cur?.effortSource !== 'hook') {
        patch.effort = markers.effortEcho;
        patch.effortSource = 'echo';
      }
    }
    if (Object.keys(patch).length > 0 && sink.peek(markers.sessionId)) {
      sink.patch(markers.sessionId, patch);
    }
    this.recompute(markers.sessionId);
  }

  /** 来自 /hooks 的 hook 事件。 */
  onHook(payload: HookPayload): void {
    const sink = this.sink;
    if (!sink || typeof payload?.session_id !== 'string') return;
    const sid = payload.session_id;
    const r = this.rawOf(sid);
    r.hook = { payload, at: this.now() };
    // hook 携带的 effort.level 是该会话「当前 turn」的真实推理强度。
    const hookEffort = payload.effort?.level;
    if (!sink.peek(sid)) {
      sink.patch(sid, {
        cwd: payload.cwd ?? '',
        project: payload.cwd ? basename(payload.cwd) : '',
        ...(payload.permission_mode ? { permissionMode: payload.permission_mode } : {}),
        ...(hookEffort ? { effort: hookEffort, effortSource: 'hook' as const } : {}),
      });
    } else {
      const patch: ProviderPatch = {};
      if (payload.permission_mode) patch.permissionMode = payload.permission_mode;
      if (hookEffort) {
        patch.effort = hookEffort;
        patch.effortSource = 'hook';
      }
      if (Object.keys(patch).length > 0) sink.patch(sid, patch);
    }
    if (payload.cwd) this.maybeTrack(sid, payload.cwd);
    // hook 驱动的状态（尤其 NEEDS_APPROVAL/DONE）立即生效，不去抖。
    this.recompute(sid, /*immediate*/ true);
  }

  /** 来自 SubagentWatcher 的子代理/workflow 遥测——纯展示，直接 patch 不进 reconcile。 */
  onSubagentStats(s: SubagentStats): void {
    const sink = this.sink;
    if (!sink || !sink.peek(s.sessionId)) return;
    const patch: ProviderPatch = {
      subagentTokens: s.subagentTokens,
      agentCount: s.agentCount,
      workflowCount: s.workflowCount,
      workflowAgentCount: s.workflowAgentCount,
      workflowActive: s.workflowActive,
    };
    if (s.lastWorkflowAt !== undefined) patch.lastWorkflowAt = s.lastWorkflowAt;
    sink.patch(s.sessionId, patch);
  }

  /** 来自 reaper 的判死。 */
  onPidDead(pid: number): void {
    this.onFileRemoved(pid);
  }

  /** 供 reaper 拿当前追踪的存活 pid 列表（本 provider 的会话）。 */
  livePids(): number[] {
    const sink = this.sink;
    const out: number[] = [];
    if (!sink) return out;
    for (const [pid, sid] of this.pidToSid) {
      const s = sink.peek(sid);
      if (s && s.pid === pid && s.state !== 'DEAD') out.push(pid);
    }
    return out;
  }

  // ——— 内部 ———

  private rawOf(sessionId: string): RawInputs {
    let r = this.raw.get(sessionId);
    if (!r) {
      r = {};
      this.raw.set(sessionId, r);
    }
    return r;
  }

  /** 首次拿到会话 cwd 时通知 tailer/subagents 开始跟踪（幂等）。 */
  private maybeTrack(sessionId: string, cwd: string): void {
    if (!cwd || this.trackedSessions.has(sessionId)) return;
    this.trackedSessions.add(sessionId);
    this.tailer.track(sessionId, cwd);
    this.subagents.track(sessionId, cwd);
  }

  /** 判死后停止跟踪该会话。 */
  private untrack(sessionId: string): void {
    this.trackedSessions.delete(sessionId);
    this.tailer.untrack(sessionId);
    this.subagents.untrack(sessionId);
  }

  /** 把文件快照的身份/上下文字段写进 store（不含状态）。 */
  private applyIdentity(snap: SessionFileSnapshot): void {
    const sink = this.sink;
    if (!sink) return;
    const patch: ProviderPatch = {
      pid: snap.pid,
      name: snap.name,
      cwd: snap.cwd,
      project: basename(snap.cwd),
      fileStatus: snap.status,
      lastActivityAt: Math.max(snap.statusUpdatedAt ?? 0, snap.updatedAt ?? 0, this.now()),
    };
    if (snap.nameSource !== undefined) patch.nameSource = snap.nameSource;
    if (snap.waitingFor !== undefined) patch.waitingFor = snap.waitingFor;
    if (snap.startedAt !== undefined) patch.startedAt = snap.startedAt;
    // effort 全局默认兜底：仅当会话尚无 hook 来源的真实值时填入（不覆盖 hook）。
    const existing = sink.peek(snap.sessionId);
    if (this.cfg.defaultEffort && existing?.effortSource !== 'hook' && existing?.effort === undefined) {
      patch.effort = this.cfg.defaultEffort;
      patch.effortSource = 'default';
    }
    sink.patch(snap.sessionId, patch);
  }

  private recompute(sessionId: string, immediate = false): void {
    const sink = this.sink;
    if (!sink) return;
    const r = this.raw.get(sessionId);
    if (!r) return;
    const prev = sink.peek(sessionId)?.state;

    const inputs: ReconcilerInputs = {
      ...(r.file ? { file: r.file } : {}),
      ...(r.markers ? { markers: r.markers } : {}),
      ...(r.hook ? { hook: r.hook } : {}),
      ...(prev ? { previous: prev } : {}),
      ...(r.deadPid !== undefined ? { liveness: { pid: r.deadPid, alive: false } } : {}),
    };

    const { state, reason } = this.reconciler.reconcile(inputs);
    sink.setState(sessionId, state, { immediate, ...(reason ? { reason } : {}) });
    if (state === 'DEAD') this.untrack(sessionId);
  }
}

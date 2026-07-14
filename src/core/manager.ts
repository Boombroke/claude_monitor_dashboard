/**
 * manager.ts — 编排层：把各信号源汇入 reconciler，写进 store，广播出去。
 *
 * 数据流：
 *   sessionsWatcher.onUpsert ─┐
 *   transcriptTailer.markers ─┼─→ per-session 原始态缓存 ─→ reconcile() ─→ store.setState
 *   hooks/receiver.onHook ────┤                                            │
 *   liveness reaper.onDead ───┘                                            ▼
 *                                                       store.subscribe → SSE 广播 + notifier
 *
 * 每会话维护 ReconcilerInputs 的最新分量；任一分量变化即重算状态。
 * 进入 IDLE/DONE_WAITING 的转移做去抖（busy 立即生效，保持跟手）。
 */

import { basename } from 'node:path';
import type {
  Config,
  HookPayload,
  ReconcilerInputs,
  Reconciler,
  SessionFileSnapshot,
  SessionStore,
  TranscriptMarkers,
  Notifier,
  ServerEvent,
  Session,
} from '../types.ts';

export interface ManagerDeps {
  cfg: Config;
  store: SessionStore;
  reconciler: Reconciler;
  notifier?: Notifier;
  /** 广播 store 变更到 SSE。 */
  broadcast: (event: ServerEvent) => void;
  now?: () => number;
}

/** 每会话的原始输入缓存（reconcile 的分量来源）。 */
interface RawInputs {
  file?: SessionFileSnapshot;
  markers?: TranscriptMarkers;
  hook?: { payload: HookPayload; at: number };
  deadPid?: number; // 被 reaper 判死的 pid
}

const DEBOUNCED_STATES = new Set(['IDLE', 'DONE_WAITING']);

export class SessionManager {
  private readonly cfg: Config;
  private readonly store: SessionStore;
  private readonly reconciler: Reconciler;
  private readonly notifier: Notifier | undefined;
  private readonly broadcast: (event: ServerEvent) => void;
  private readonly now: () => number;

  private readonly raw = new Map<string, RawInputs>();
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();

  constructor(deps: ManagerDeps) {
    this.cfg = deps.cfg;
    this.store = deps.store;
    this.reconciler = deps.reconciler;
    this.notifier = deps.notifier;
    this.broadcast = deps.broadcast;
    this.now = deps.now ?? Date.now;

    // store 变更 → SSE 广播 + notifier 转移通知。
    this.store.subscribe((change) => {
      if (change.type === 'remove') {
        this.broadcast({ type: 'session.remove', sessionId: change.sessionId });
        return;
      }
      this.broadcast({ type: 'session.update', session: change.session });
      if (this.notifier && change.prev !== undefined && change.prev !== change.session.state) {
        this.notifier.onTransition(change.session, change.prev);
      }
    });
  }

  // ——— 信号入口 ———

  /** 来自 sessionsWatcher 的文件快照。 */
  onFileSnapshot(snap: SessionFileSnapshot): void {
    const r = this.rawOf(snap.sessionId);
    r.file = snap;
    r.deadPid = undefined;
    // 先把身份/上下文字段写入 store（即使状态不变，UI 也要更新 name/cwd/pid）。
    this.applyIdentity(snap);
    this.recompute(snap.sessionId);
  }

  /** sessions 文件被删（pid 维度）→ 定位会话并判死。 */
  onFileRemoved(pid: number): void {
    const s = this.store.getByPid(pid);
    if (!s) return;
    // 若该 pid 仍是会话当前 pid，标记死亡；resume 换 pid 的情况由 store 处理。
    if (s.pid === pid) {
      const r = this.rawOf(s.sessionId);
      r.deadPid = pid;
      this.recompute(s.sessionId, /*immediate*/ true);
    }
  }

  /** 来自 transcriptTailer 的标记。 */
  onMarkers(markers: TranscriptMarkers): void {
    const r = this.rawOf(markers.sessionId);
    r.markers = { ...r.markers, ...markers };
    // 上下文字段直接进 store。
    const patch: Partial<Session> = {};
    if (markers.currentTitle !== undefined) patch.currentTitle = markers.currentTitle;
    if (markers.lastPrompt !== undefined) patch.lastPrompt = markers.lastPrompt;
    if (markers.lastAssistantSummary !== undefined)
      patch.lastAssistantSummary = markers.lastAssistantSummary;
    if (markers.model !== undefined) patch.model = markers.model;
    if (markers.gitBranch !== undefined) patch.gitBranch = markers.gitBranch;
    if (markers.permissionMode !== undefined) patch.permissionMode = markers.permissionMode;
    if (Object.keys(patch).length > 0 && this.store.get(markers.sessionId)) {
      this.store.upsert(markers.sessionId, patch);
    }
    this.recompute(markers.sessionId);
  }

  /** 来自 /hooks 的 hook 事件。 */
  onHook(payload: HookPayload): void {
    const sid = payload.session_id;
    const r = this.rawOf(sid);
    r.hook = { payload, at: this.now() };
    // hook 可能先于文件出现该会话；确保 store 有占位。
    if (!this.store.get(sid)) {
      this.store.upsert(sid, {
        cwd: payload.cwd ?? '',
        project: payload.cwd ? basename(payload.cwd) : '',
        ...(payload.permission_mode ? { permissionMode: payload.permission_mode } : {}),
      });
    } else if (payload.permission_mode) {
      this.store.upsert(sid, { permissionMode: payload.permission_mode });
    }
    // hook 驱动的状态（尤其 NEEDS_APPROVAL/DONE）立即生效，不去抖。
    this.recompute(sid, /*immediate*/ true);
  }

  /** 来自 reaper 的判死。 */
  onPidDead(pid: number): void {
    this.onFileRemoved(pid);
  }

  /** 供 reaper 拿当前追踪的 pid 列表。 */
  livePids(): number[] {
    const out: number[] = [];
    for (const s of this.store.all()) {
      if (s.pid !== null && s.state !== 'DEAD') out.push(s.pid);
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

  /** 把文件快照的身份/上下文字段写进 store（不含状态）。 */
  private applyIdentity(snap: SessionFileSnapshot): void {
    const patch: Partial<Session> = {
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
    this.store.upsert(snap.sessionId, patch);
  }

  private recompute(sessionId: string, immediate = false): void {
    const r = this.raw.get(sessionId);
    if (!r) return;
    const prev = this.store.get(sessionId)?.state;

    const inputs: ReconcilerInputs = {
      ...(r.file ? { file: r.file } : {}),
      ...(r.markers ? { markers: r.markers } : {}),
      ...(r.hook ? { hook: r.hook } : {}),
      ...(prev ? { previous: prev } : {}),
      ...(r.deadPid !== undefined ? { liveness: { pid: r.deadPid, alive: false } } : {}),
    };

    const { state, reason } = this.reconciler.reconcile(inputs);

    const commit = () => {
      this.debounceTimers.delete(sessionId);
      this.store.setState(sessionId, state, reason);
    };

    // 进入 WORKING / 需要你 立即生效；进入 IDLE/DONE 去抖，吸收工具边界抖动。
    if (immediate || !DEBOUNCED_STATES.has(state) || this.cfg.stateDebounceMs <= 0) {
      const t = this.debounceTimers.get(sessionId);
      if (t) {
        clearTimeout(t);
        this.debounceTimers.delete(sessionId);
      }
      commit();
      return;
    }

    const existing = this.debounceTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(commit, this.cfg.stateDebounceMs);
    timer.unref?.();
    this.debounceTimers.set(sessionId, timer);
  }
}

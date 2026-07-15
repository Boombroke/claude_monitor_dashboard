/**
 * store.ts — SessionStore 实现。
 *
 * 键 = sessionId（稳定 UUID）。维护 Map<pid, sessionId> 副索引，供文件/存活性
 * 事件从 pid 快速定位会话。--resume 会用新 pid 复用同一 sessionId，此时更新
 * pid/pastPids 而非新建。
 *
 * upsert/setState 会触发订阅者（server SSE、notifier）。setState 负责写入 events
 * 时间线、更新 stateSince/needsAttention/attentionReason。
 */

import type {
  Session,
  SessionState,
  SessionStore,
  StoreChange,
  StoreListener,
  SessionEvent,
} from '../types.ts';
import { ATTENTION_STATES } from '../types.ts';

const EVENTS_RING_MAX = 50;

/** 由 setState 内部用于取"现在"，测试可注入。默认 Date.now。 */
export interface StoreOptions {
  now?: () => number;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly pidIndex = new Map<number, string>();
  private readonly listeners = new Set<StoreListener>();
  private readonly now: () => number;

  constructor(opts: StoreOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  getByPid(pid: number): Session | undefined {
    const id = this.pidIndex.get(pid);
    return id ? this.sessions.get(id) : undefined;
  }

  all(): Session[] {
    return [...this.sessions.values()];
  }

  upsert(sessionId: string, patch: Partial<Session>): Session {
    const existing = this.sessions.get(sessionId);
    const prevState = existing?.state;

    if (existing) {
      // 处理 pid 变更（resume）：把旧 pid 归档进 pastPids，重建 pid 索引。
      if (patch.pid !== undefined && patch.pid !== null && patch.pid !== existing.pid) {
        if (existing.pid !== null && !existing.pastPids.includes(existing.pid)) {
          existing.pastPids.push(existing.pid);
        }
        if (existing.pid !== null) this.pidIndex.delete(existing.pid);
        this.pidIndex.set(patch.pid, sessionId);
      }
      Object.assign(existing, patch);
      // needsAttention 始终由 state 派生，避免 patch 带入不一致值。
      existing.needsAttention = ATTENTION_STATES.has(existing.state);
      this.emit({ type: 'upsert', session: existing, ...(prevState ? { prev: prevState } : {}) });
      return existing;
    }

    const created = this.materialize(sessionId, patch);
    this.sessions.set(sessionId, created);
    if (created.pid !== null) this.pidIndex.set(created.pid, sessionId);
    this.emit({ type: 'upsert', session: created });
    return created;
  }

  setState(sessionId: string, state: SessionState, reason?: string): Session | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    if (s.state === state) {
      // 无状态变化：仅在 reason 变化时更新，不推时间线事件。
      if (reason !== undefined && reason !== s.attentionReason && ATTENTION_STATES.has(state)) {
        s.attentionReason = reason;
        this.emit({ type: 'upsert', session: s, prev: state });
      }
      return s;
    }

    const from = s.state;
    const at = this.now();
    s.state = state;
    s.stateSince = at;
    s.needsAttention = ATTENTION_STATES.has(state);
    s.attentionReason = s.needsAttention ? (reason ?? this.defaultReason(state)) : undefined;
    this.pushEvent(s, { at, kind: 'state', from, to: state, ...(reason ? { detail: reason } : {}) });

    this.emit({ type: 'upsert', session: s, prev: from });
    return s;
  }

  remove(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.pid !== null) this.pidIndex.delete(s.pid);
    for (const p of s.pastPids) {
      if (this.pidIndex.get(p) === sessionId) this.pidIndex.delete(p);
    }
    this.sessions.delete(sessionId);
    this.emit({ type: 'remove', sessionId });
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 追加一条时间线事件，维护环形缓冲上限。 */
  pushEvent(s: Session, ev: SessionEvent): void {
    s.events.push(ev);
    if (s.events.length > EVENTS_RING_MAX) {
      s.events.splice(0, s.events.length - EVENTS_RING_MAX);
    }
  }

  private emit(change: StoreChange): void {
    for (const l of this.listeners) {
      try {
        l(change);
      } catch {
        // 监听器自身错误不应影响 store 或其他监听器。
      }
    }
  }

  /** 用默认值补齐一个新 Session。 */
  private materialize(sessionId: string, patch: Partial<Session>): Session {
    const at = this.now();
    const state: SessionState = patch.state ?? 'IDLE';
    const base: Session = {
      sessionId,
      pid: patch.pid ?? null,
      pastPids: patch.pastPids ?? [],
      name: patch.name ?? sessionId.slice(0, 8),
      cwd: patch.cwd ?? '',
      project: patch.project ?? '',
      state,
      isBackground: patch.isBackground ?? false,
      startedAt: patch.startedAt ?? at,
      lastActivityAt: patch.lastActivityAt ?? at,
      stateSince: patch.stateSince ?? at,
      isAlive: patch.isAlive ?? true,
      needsAttention: ATTENTION_STATES.has(state),
      events: patch.events ?? [],
    };
    // 复制可选字段（避免把 undefined 显式写入）。
    const optional: (keyof Session)[] = [
      'nameSource',
      'gitBranch',
      'fileStatus',
      'waitingFor',
      'permissionMode',
      'currentTitle',
      'lastPrompt',
      'lastAssistantSummary',
      'recentReplies',
      'contextTokens',
      'contextWindow',
      'effort',
      'effortSource',
      'ultracode',
      'model',
      'attentionReason',
    ];
    for (const k of optional) {
      const v = patch[k];
      if (v !== undefined) (base as unknown as Record<string, unknown>)[k] = v;
    }
    return base;
  }

  private defaultReason(state: SessionState): string | undefined {
    switch (state) {
      case 'NEEDS_APPROVAL':
        return '需要审批';
      case 'IDLE_INPUT':
        return '等待输入';
      case 'DONE_WAITING':
        return '完成一轮';
      default:
        return undefined;
    }
  }
}

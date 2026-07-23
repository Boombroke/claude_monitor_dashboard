/**
 * hub.ts — provider 无关的提交引擎。
 *
 * 订阅 store 变更 → 扇出（SSE 广播 + notifier 转移通知 + 历史持久化）。
 * makeSink(agent) 给每个 provider 一个绑定 agent 的写入面：provider 用 RAW
 * sessionId，sink 注入 agent 算出复合 key，并对 IDLE/DONE_WAITING 统一去抖
 * （WORKING/需要你/immediate 立即提交）——所有 provider 免费共享这套抖动吸收。
 */

import type {
  AgentKind,
  Config,
  Notifier,
  ServerEvent,
  Session,
  SessionState,
  SessionStore,
} from '../types.ts';
import type { SessionSink } from '../providers/types.ts';

export interface HubDeps {
  cfg: Config;
  store: SessionStore;
  notifier?: Notifier;
  broadcast: (event: ServerEvent) => void;
  onStateTransition?: (session: Session, from: SessionState | undefined) => void;
  now?: () => number;
}

const DEBOUNCED_STATES: ReadonlySet<SessionState> = new Set<SessionState>(['IDLE', 'DONE_WAITING']);

/** 复合键：跨 provider 唯一。 */
export function keyOf(agent: AgentKind, sessionId: string): string {
  return `${agent}:${sessionId}`;
}

export class Hub {
  private readonly cfg: Config;
  private readonly store: SessionStore;
  private readonly notifier: Notifier | undefined;
  private readonly broadcast: (event: ServerEvent) => void;
  private readonly onStateTransition:
    | ((session: Session, from: SessionState | undefined) => void)
    | undefined;
  private readonly now: () => number;
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();

  constructor(deps: HubDeps) {
    this.cfg = deps.cfg;
    this.store = deps.store;
    this.notifier = deps.notifier;
    this.broadcast = deps.broadcast;
    this.onStateTransition = deps.onStateTransition;
    this.now = deps.now ?? Date.now;

    this.store.subscribe((change) => {
      if (change.type === 'remove') {
        this.broadcast({ type: 'session.remove', key: change.key });
        return;
      }
      this.broadcast({ type: 'session.update', session: change.session });
      if (change.prev !== undefined && change.prev !== change.session.state) {
        if (this.notifier) this.notifier.onTransition(change.session, change.prev);
        this.onStateTransition?.(change.session, change.prev);
      }
    });
  }

  /** 给一个 provider 发一个绑定其 agent 的 sink（provider 全程用 RAW sessionId）。 */
  makeSink(agent: AgentKind): SessionSink {
    return {
      now: () => this.now(),
      peek: (sessionId) => this.store.get(keyOf(agent, sessionId)),
      patch: (sessionId, patch) => {
        const key = keyOf(agent, sessionId);
        this.store.upsert(key, { agent, sessionId, key, ...patch });
      },
      setState: (sessionId, state, opts) => this.commit(agent, sessionId, state, opts),
      markDead: (sessionId, reason) =>
        this.commit(agent, sessionId, 'DEAD', { immediate: true, ...(reason ? { reason } : {}) }),
    };
  }

  /** 统一提交：IDLE/DONE_WAITING 去抖，其余（含 DEAD）立即。 */
  private commit(
    agent: AgentKind,
    sessionId: string,
    state: SessionState,
    opts?: { reason?: string; detail?: string; immediate?: boolean },
  ): void {
    const key = keyOf(agent, sessionId);
    if (opts?.detail !== undefined) {
      this.store.upsert(key, { agent, sessionId, key, stateDetail: opts.detail });
    }
    const reason = opts?.reason;
    const doCommit = () => {
      this.debounceTimers.delete(key);
      this.store.setState(key, state, reason);
    };
    if (opts?.immediate || !DEBOUNCED_STATES.has(state) || this.cfg.stateDebounceMs <= 0) {
      const t = this.debounceTimers.get(key);
      if (t) {
        clearTimeout(t);
        this.debounceTimers.delete(key);
      }
      doCommit();
      return;
    }
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(doCommit, this.cfg.stateDebounceMs);
    timer.unref?.();
    this.debounceTimers.set(key, timer);
  }
}

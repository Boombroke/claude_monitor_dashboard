/**
 * providers/types.ts — 多 agent provider 接缝。
 *
 * 每个 Provider 拥有自己的采集与状态推导，通过 SessionSink 把「已归一化的权威
 * 状态」写入共享内核（store/debounce/fan-out）。Provider 全程使用 RAW sessionId；
 * 绑定的 sink 负责注入 agent 并算出复合 key（`${agent}:${sessionId}`）。
 */

import type { AgentKind, Session, SessionState } from '../types.ts';

/** Provider 可写入的字段：仅身份/上下文；state 相关字段由 setState 独占。 */
export type ProviderPatch = Omit<
  Partial<Session>,
  'sessionId' | 'agent' | 'key' | 'state' | 'needsAttention' | 'stateSince' | 'attentionReason' | 'stateDetail' | 'events'
>;

/** 已绑定某 agent 的写入面。Provider 传 RAW sessionId，sink 内部算复合 key。 */
export interface SessionSink {
  now(): number;
  /** 读当前已提交会话（复合键内部解析）；provider 借此读回自己写过的上下文/上一状态。 */
  peek(sessionId: string): Session | undefined;
  patch(sessionId: string, patch: ProviderPatch): void;
  /** 权威状态写入。IDLE/DONE_WAITING 默认去抖，immediate 立即提交（内核统一规则）。 */
  setState(
    sessionId: string,
    state: SessionState,
    opts?: { reason?: string; detail?: string; immediate?: boolean },
  ): void;
  markDead(sessionId: string, reason?: string): void;
}

/** 一个 agent CLI 的监控 provider：自持采集生命周期，向 sink 输出归一化状态。 */
export interface Provider {
  readonly agent: AgentKind;
  start(sink: SessionSink): Promise<void>;
  stop(): Promise<void>;
  /** 可选：接收 HTTP 推送（Claude hooks / opencode 插件）解析后的 body。 */
  onPush?(body: unknown): void;
}

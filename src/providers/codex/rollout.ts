/**
 * providers/codex/rollout.ts — Codex rollout JSONL 解析（纯函数，可测）。
 *
 * rollout 每行是一条 RolloutLine：{ timestamp, ordinal?, type, payload }。
 * Codex 无显式 status 字段——状态由 event_msg 的 payload.type 推导。
 */

import { join } from 'node:path';
import type { SessionState } from '../../types.ts';

/** ~/.codex/sessions 根（rollout 按 YYYY/MM/DD 分桶）。 */
export function codexSessionsDir(codexHome: string): string {
  return join(codexHome, 'sessions');
}

export interface RolloutLine {
  type: string;
  payload: unknown;
  timestamp?: string;
}

/** 解析一行 rollout；非法/半写行返回 undefined。 */
export function parseRolloutLine(raw: string): RolloutLine | undefined {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (o === null || typeof o !== 'object') return undefined;
  const r = o as Record<string, unknown>;
  if (typeof r.type !== 'string') return undefined;
  return {
    type: r.type,
    payload: r.payload,
    ...(typeof r.timestamp === 'string' ? { timestamp: r.timestamp } : {}),
  };
}

const START: ReadonlySet<string> = new Set(['task_started', 'turn_started']);
const DONE: ReadonlySet<string> = new Set(['task_complete', 'turn_complete', 'turn_aborted']);
const APPROVAL: ReadonlySet<string> = new Set([
  'exec_approval_request',
  'apply_patch_approval_request',
  'patch_apply_approval_request',
  'request_permissions',
]);
const INPUT: ReadonlySet<string> = new Set(['request_user_input']);

/**
 * event_msg.payload.type + 当前状态 → 新状态（Codex 状态推导核心）。
 * 阻塞态（审批 / 等待输入）遇到任意后续活动事件即视为已恢复 WORKING。
 * 返回 undefined = 该事件不驱动状态（调用方保留原状态）。
 */
export function reduceCodexState(
  current: SessionState | undefined,
  eventType: string,
): SessionState | undefined {
  if (eventType === 'shutdown_complete') return 'DEAD';
  if (START.has(eventType)) return 'WORKING';
  if (APPROVAL.has(eventType)) return 'NEEDS_APPROVAL';
  if (INPUT.has(eventType)) return 'IDLE_INPUT';
  if (DONE.has(eventType)) return 'DONE_WAITING';
  if (current === 'NEEDS_APPROVAL' || current === 'IDLE_INPUT') return 'WORKING';
  return undefined;
}

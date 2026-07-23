/**
 * providers/opencode/mapEvent.ts — opencode 推送事件 → 归一化 patch/state（纯函数）。
 *
 * opencode 是 client/server：其插件的 event 钩子把会话事件 POST 到 /ingest/opencode。
 * opencode 显式状态 busy/idle/retry 走 session.status；审批/提问是独立事件
 * （permission.asked / question.asked）；opencode 无「完成待确认」概念——
 * busy→idle 时借上一状态合成 DONE_WAITING（对齐 Claude 的 hasUnacknowledgedDone）。
 */

import { basename } from 'node:path';
import type { SessionState } from '../../types.ts';
import type { ProviderPatch } from '../types.ts';

/** 插件 POST 到 /ingest/opencode 的归一化 body。 */
export interface OpencodeIngest {
  sessionID?: string;
  event?: string;
  status?: string;
  directory?: string;
  title?: string;
  model?: string;
}

export interface MappedOpencode {
  sessionID: string;
  patch: ProviderPatch;
  state?: SessionState;
  detail?: string;
  dead?: boolean;
}

export function mapOpencodeEvent(raw: unknown, prev: SessionState | undefined): MappedOpencode | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const b = raw as OpencodeIngest;
  if (typeof b.sessionID !== 'string' || b.sessionID.length === 0) return undefined;

  const patch: ProviderPatch = {};
  if (typeof b.directory === 'string' && b.directory.length > 0) {
    patch.cwd = b.directory;
    patch.project = basename(b.directory);
    patch.name = basename(b.directory);
  }
  if (typeof b.title === 'string' && b.title.length > 0) patch.currentTitle = b.title;
  if (typeof b.model === 'string' && b.model.length > 0) patch.model = b.model;

  const res: MappedOpencode = { sessionID: b.sessionID, patch };
  switch (b.event) {
    case 'session.deleted':
      res.dead = true;
      break;
    case 'permission.asked':
      res.state = 'NEEDS_APPROVAL';
      break;
    case 'question.asked':
      res.state = 'IDLE_INPUT';
      break;
    case 'session.status':
      if (b.status === 'busy') res.state = 'WORKING';
      else if (b.status === 'retry') {
        res.state = 'WORKING';
        res.detail = '重试中';
      } else if (b.status === 'idle') res.state = prev === 'WORKING' ? 'DONE_WAITING' : 'IDLE';
      break;
    case 'session.idle':
      res.state = prev === 'WORKING' ? 'DONE_WAITING' : 'IDLE';
      break;
    default:
      break;
  }
  return res;
}

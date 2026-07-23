/**
 * providers/opencode/provider.ts — opencode 监控 provider（推送驱动）。
 *
 * opencode 服务器端口随机、无落盘 URL，故采用「插件推送」：opencode 插件的 event
 * 钩子把会话事件 POST 到 /ingest/opencode，本 provider 的 onPush 消费并写入 sink。
 * 无文件监听、无轮询；start/stop 仅持有 sink。
 */

import type { Config } from '../../types.ts';
import type { Provider, SessionSink } from '../types.ts';
import { mapOpencodeEvent } from './mapEvent.ts';

export class OpencodeProvider implements Provider {
  readonly agent = 'opencode' as const;
  private sink: SessionSink | undefined;

  constructor(_cfg: Config) {}

  async start(sink: SessionSink): Promise<void> {
    this.sink = sink;
  }

  async stop(): Promise<void> {
    this.sink = undefined;
  }

  /** 来自 /ingest/opencode 的插件推送。 */
  onPush(body: unknown): void {
    const sink = this.sink;
    if (!sink) return;
    const sid = body && typeof body === 'object' ? (body as { sessionID?: unknown }).sessionID : undefined;
    const prev = typeof sid === 'string' ? sink.peek(sid)?.state : undefined;
    const m = mapOpencodeEvent(body, prev);
    if (!m) return;
    // 首个事件即使 patch 为空也要 patch 一次，确保会话被创建（materialize 补默认值）。
    if (Object.keys(m.patch).length > 0 || !sink.peek(m.sessionID)) sink.patch(m.sessionID, m.patch);
    if (m.dead) {
      sink.markDead(m.sessionID);
      return;
    }
    if (m.state) sink.setState(m.sessionID, m.state, m.detail ? { detail: m.detail } : undefined);
  }
}

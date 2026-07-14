/**
 * sse.ts — Server-Sent Events 广播中心。
 *
 * 每个浏览器客户端一个连接。连接建立即发 snapshot，随后按 store 变更推
 * session.update / session.remove，按 notifier 推 notification。
 * 15s 心跳注释保活。
 */

import type { ServerReply } from './http.ts';
import type { Session, ServerEvent } from '../types.ts';

const HEARTBEAT_MS = 15_000;

interface Client {
  id: number;
  reply: ServerReply;
}

export class SseHub {
  private readonly clients = new Map<number, Client>();
  private nextId = 1;
  private heartbeat: NodeJS.Timeout | undefined;

  /** 接入一个新 SSE 客户端；写出 SSE 头并发送初始 snapshot。 */
  addClient(reply: ServerReply, snapshot: Session[], serverTime: number): number {
    const id = this.nextId++;
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // 建议客户端重连间隔。
    reply.raw.write('retry: 3000\n\n');
    const client: Client = { id, reply };
    this.clients.set(id, client);

    this.writeTo(client, { type: 'snapshot', sessions: snapshot, serverTime });

    reply.raw.on('close', () => this.clients.delete(id));

    this.ensureHeartbeat();
    return id;
  }

  /** 广播一个事件给所有客户端。 */
  broadcast(event: ServerEvent): void {
    for (const c of this.clients.values()) this.writeTo(c, event);
  }

  clientCount(): number {
    return this.clients.size;
  }

  close(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    for (const c of this.clients.values()) {
      try {
        c.reply.raw.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }

  private writeTo(client: Client, event: ServerEvent): void {
    try {
      client.reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      this.clients.delete(client.id);
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const c of this.clients.values()) {
        try {
          c.reply.raw.write(': ping\n\n');
        } catch {
          this.clients.delete(c.id);
        }
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }
}

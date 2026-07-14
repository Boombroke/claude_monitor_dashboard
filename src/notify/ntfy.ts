/**
 * ntfy.ts — ntfy.sh 推送渠道。
 *
 * HTTP POST 到 `${server}/${topic}`，body 为正文，Title/Priority/Tags 走 header。
 * ntfy 要求 header 值为 latin-1；标题若含非 latin-1（中文/emoji）则退回一个
 * ASCII 安全标题，并把完整标题并入正文。所有错误自捕获，返回是否成功。
 */

import type { Notification, NotificationChannel, NotificationPriority } from '../types.ts';

export interface NtfyChannelConfig {
  server: string;
  topic: string;
  includeContext: boolean;
  /** 是否给 done 类也发 ntfy（默认只发 needs-you）。 */
  ntfyOnDone: boolean;
}

/** header 值是否可安全用 latin-1 表示。 */
function isLatin1(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0xff) return false;
  }
  return true;
}

function priorityHeader(p: NotificationPriority): string {
  // ntfy 优先级：1..5；映射 low/default/high。
  switch (p) {
    case 'high':
      return 'high';
    case 'low':
      return 'low';
    default:
      return 'default';
  }
}

export class NtfyChannel implements NotificationChannel {
  readonly name = 'ntfy';
  private readonly server: string;
  private readonly topic: string;
  private readonly includeContext: boolean;
  private readonly ntfyOnDone: boolean;

  constructor(config: NtfyChannelConfig) {
    // 去掉 server 结尾多余的斜杠。
    this.server = config.server.replace(/\/+$/, '');
    this.topic = config.topic;
    this.includeContext = config.includeContext;
    this.ntfyOnDone = config.ntfyOnDone;
  }

  handles(n: Notification): boolean {
    if (n.class === 'needs-you') return true;
    if (n.class === 'done') return this.ntfyOnDone;
    return false; // info 不发 ntfy
  }

  async send(n: Notification): Promise<boolean> {
    try {
      const url = `${this.server}/${this.topic}`;
      const headers: Record<string, string> = {
        Priority: priorityHeader(n.priority),
      };
      if (n.tags.length > 0) headers.Tags = n.tags.join(',');

      // 标题 latin-1 安全性处理。
      let body = n.body;
      if (isLatin1(n.title)) {
        headers.Title = n.title;
      } else {
        // 标题含非 latin-1：header 用 ASCII 占位，完整标题并入正文首行。
        headers.Title = 'ccmon';
        body = body.length > 0 ? `${n.title}\n${body}` : n.title;
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(4000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

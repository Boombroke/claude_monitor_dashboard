/**
 * desktop.ts — macOS 桌面通知渠道（osascript）。
 *
 * 不引入 node-notifier 等依赖，直接 shell 出 osascript。所有错误自捕获，
 * 绝不抛给 notifier；send 返回是否成功。
 */

import { execFile } from 'node:child_process';
import type { Notification, NotificationChannel } from '../types.ts';

/** 转义要嵌入 AppleScript 双引号字符串的文本（反斜杠与双引号）。 */
function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export class DesktopChannel implements NotificationChannel {
  readonly name = 'desktop';
  private readonly enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  handles(_n: Notification): boolean {
    return this.enabled;
  }

  send(n: Notification): Promise<boolean> {
    return new Promise((resolve) => {
      const title = escapeAppleScript(n.title);
      const body = escapeAppleScript(n.body);
      const script = `display notification "${body}" with title "${title}"`;
      execFile('osascript', ['-e', script], { timeout: 3000 }, (err) => {
        resolve(!err);
      });
    });
  }
}

/**
 * presence.ts — 存在感检测（macOS，best-effort，启发式）。
 *
 * 目的：当用户此刻正坐在机器前（近期有键鼠输入）时，抑制桌面响铃，避免打扰。
 * 判定依据：ioreg 读 IOHIDSystem 的 HIDIdleTime（纳秒）——空闲时间很短即视为
 * 用户在场。所有失败一律返回 false（假定不在场，让通知照常发出）。
 *
 * 说明：这是启发式，不做精确的 TTY 匹配（前台终端 pane 的 TTY 难以稳定获取）。
 * 只要机器近期有输入活动即认为「用户在场」，ntfy 不受此影响（离机通道）。
 */

import { execFile } from 'node:child_process';

/** 认为「在场」的空闲阈值（毫秒）。空闲小于此值 → 用户在场。 */
const PRESENT_IDLE_MS = 30_000;

/** 读取系统 HID 空闲时间（毫秒）。失败返回 undefined。 */
export function hidIdleMs(): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile('ioreg', ['-c', 'IOHIDSystem'], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) {
        resolve(undefined);
        return;
      }
      // 形如： "HIDIdleTime" = 1234567890  （纳秒）
      const m = stdout.toString().match(/"HIDIdleTime"\s*=\s*(\d+)/);
      if (!m || m[1] === undefined) {
        resolve(undefined);
        return;
      }
      const ns = Number(m[1]);
      if (!Number.isFinite(ns)) {
        resolve(undefined);
        return;
      }
      resolve(ns / 1_000_000); // ns → ms
    });
  });
}

/** 查询指定 pid 的控制终端（ps -p <pid> -o tty=）。失败返回 undefined。 */
export function frontmostTty(): Promise<string | undefined> {
  // 前台终端 pane 的 TTY 无稳定跨终端获取方式；此处保留接口，暂返回 undefined。
  return Promise.resolve(undefined);
}

/**
 * 用户是否正在该会话的终端前活动（启发式）。
 * 保守策略：仅依据机器整体输入空闲时间；无法判定时返回 false（不抑制）。
 */
export async function isUserPresentAtSession(_pid: number | null): Promise<boolean> {
  const idle = await hidIdleMs();
  if (idle === undefined) return false; // 拿不到 → 假定不在场，通知照发
  return idle < PRESENT_IDLE_MS;
}

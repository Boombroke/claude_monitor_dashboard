/**
 * focus.ts — 「进入会话」：把某会话所在的终端切到前台（macOS）。
 *
 * 策略：
 *   1. 优先按会话进程的 TTY，在 Terminal.app 里定位并聚焦对应标签页。
 *   2. 找不到（会话不在 Terminal.app、或用其他终端）→ 降级：在该会话 cwd
 *      打开一个新的 Terminal 窗口。
 *
 * 注意：这是会改动桌面状态的副作用操作（非只读）。仅 macOS 有效；其它平台
 * 直接返回 unsupported。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export type FocusResult =
  | { ok: true; method: 'focused-tab' | 'opened-new' }
  | { ok: false; reason: string };

/** 查询某 pid 的控制终端，返回 /dev/ttysNNN 形式；失败返回 undefined。 */
async function ttyDevOf(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP('ps', ['-p', String(pid), '-o', 'tty='], { timeout: 2000 });
    const t = stdout.trim();
    if (!t || t === '??' || t === '?') return undefined;
    // ps 输出如 "ttys000"；AppleScript 里 tty 是 "/dev/ttys000"。
    return t.startsWith('/dev/') ? t : `/dev/${t}`;
  } catch {
    return undefined;
  }
}

/** AppleScript 字符串转义（双引号与反斜杠）。 */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * 尝试聚焦 Terminal.app 中 tty 匹配的标签页。成功返回 true。
 */
async function focusTerminalTab(ttyDev: string): Promise<boolean> {
  const script = `
    tell application "Terminal"
      set matched to false
      repeat with w in windows
        repeat with t in tabs of w
          try
            if (tty of t) is "${esc(ttyDev)}" then
              set selected of t to true
              set index of w to 1
              set frontmost of w to true
              set matched to true
            end if
          end try
        end repeat
      end repeat
      if matched then activate
      return matched
    end tell`;
  try {
    const { stdout } = await execFileP('osascript', ['-e', script], { timeout: 4000 });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** 降级：在指定目录打开一个新 Terminal 窗口。 */
async function openNewTerminalAt(cwd: string): Promise<boolean> {
  try {
    // `open -a Terminal <dir>` 会在该目录打开/激活一个 Terminal 窗口。
    await execFileP('open', ['-a', 'Terminal', cwd], { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 进入会话：聚焦其终端标签页，或降级在其 cwd 开新终端。
 * pid 可能为 null（会话已无活进程），此时只能靠 cwd 开新终端。
 */
export async function focusSession(pid: number | null, cwd: string): Promise<FocusResult> {
  if (process.platform !== 'darwin') {
    return { ok: false, reason: 'unsupported-platform' };
  }

  // 1) 有 pid → 按 TTY 聚焦标签页。
  if (pid !== null) {
    const ttyDev = await ttyDevOf(pid);
    if (ttyDev) {
      const focused = await focusTerminalTab(ttyDev);
      if (focused) return { ok: true, method: 'focused-tab' };
    }
  }

  // 2) 降级：在 cwd 开新终端。
  if (cwd && cwd.length > 0) {
    const opened = await openNewTerminalAt(cwd);
    if (opened) return { ok: true, method: 'opened-new' };
  }

  return { ok: false, reason: 'no-terminal-found' };
}

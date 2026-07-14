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
  | { ok: true; method: 'focused-tab' | 'opened-new' | 'activated-editor' }
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

/**
 * 沿父进程链向上，判断会话宿主的编辑器/终端类型。
 * 返回可用 `open -a <name>` 激活的应用名，或 undefined（普通终端）。
 */
async function hostEditorApp(pid: number): Promise<string | undefined> {
  let cur = pid;
  for (let i = 0; i < 6; i++) {
    let ppid: string;
    let comm: string;
    try {
      const { stdout } = await execFileP('ps', ['-o', 'ppid=,comm=', '-p', String(cur)], { timeout: 2000 });
      const line = stdout.trim();
      const sp = line.indexOf(' ');
      ppid = sp === -1 ? '' : line.slice(0, sp).trim();
      comm = sp === -1 ? '' : line.slice(sp + 1).trim();
    } catch {
      return undefined;
    }
    const lower = comm.toLowerCase();
    // 常见编辑器集成终端的进程名特征。
    if (lower.includes('cursor')) return 'Cursor';
    if (lower.includes('code - insiders') || lower.includes('code-insiders')) return 'Visual Studio Code - Insiders';
    if (lower.includes('code helper') || lower.includes('visual studio code') || /(^|\/)code($|\s)/.test(lower)) {
      return 'Visual Studio Code';
    }
    if (lower.includes('windsurf')) return 'Windsurf';
    const next = Number(ppid);
    if (!Number.isInteger(next) || next <= 1) return undefined;
    cur = next;
  }
  return undefined;
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

/** 用 `open -a <app> <cwd>` 激活编辑器并聚焦该工作目录窗口。 */
async function activateEditorAt(app: string, cwd: string): Promise<boolean> {
  try {
    const args = cwd && cwd.length > 0 ? ['-a', app, cwd] : ['-a', app];
    await execFileP('open', args, { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 进入会话：
 *   - 会话在 VS Code / Cursor 等编辑器集成终端里 → 激活该编辑器并聚焦对应
 *     工作目录窗口（无法精确定位到具体终端面板，属编辑器限制）。
 *   - 会话在 Terminal.app 里 → 按 TTY 精确聚焦对应标签页。
 *   - 都不行 → 降级在 cwd 开新终端。
 * pid 可能为 null（会话已无活进程），此时只能靠 cwd 开新终端。
 */
export async function focusSession(pid: number | null, cwd: string): Promise<FocusResult> {
  if (process.platform !== 'darwin') {
    return { ok: false, reason: 'unsupported-platform' };
  }

  if (pid !== null) {
    // 1) 先判断宿主是不是编辑器（VS Code/Cursor 等）。
    const editor = await hostEditorApp(pid);
    if (editor) {
      const activated = await activateEditorAt(editor, cwd);
      if (activated) return { ok: true, method: 'activated-editor' };
    }
    // 2) 否则按 TTY 聚焦 Terminal.app 标签页。
    const ttyDev = await ttyDevOf(pid);
    if (ttyDev) {
      const focused = await focusTerminalTab(ttyDev);
      if (focused) return { ok: true, method: 'focused-tab' };
    }
  }

  // 3) 降级：在 cwd 开新终端。
  if (cwd && cwd.length > 0) {
    const opened = await openNewTerminalAt(cwd);
    if (opened) return { ok: true, method: 'opened-new' };
  }

  return { ok: false, reason: 'no-terminal-found' };
}

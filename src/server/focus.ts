/**
 * focus.ts — 「进入会话」：把某会话所在的终端/编辑器切到前台。
 *
 * 策略（按平台走不同阶梯，效果由「精确」向「兜底」降级）：
 *   macOS：
 *     1. 宿主是编辑器（VS Code/Cursor…）→ `open -a` 激活该编辑器窗口。
 *     2. 否则按会话进程 TTY 在 Terminal.app 里精确聚焦对应标签页。
 *     3. 都不行 → 在 cwd 开新 Terminal 窗口。
 *   Linux：
 *     1. 宿主是编辑器 → 用其 CLI（code/cursor/windsurf）聚焦该工作目录窗口。
 *     2. 尝试按「终端模拟器进程 pid」聚焦其窗口——仅在 X11 / sway / Hyprland
 *        下可行（有明确成功信号）；GNOME+Wayland 下无第三方聚焦任意窗口的接口，
 *        必然落空，走下一步兜底。
 *     3. 在 cwd 开一个新终端窗口（自动挑选可用的模拟器）。
 *
 * 注意：这是会改动桌面状态的副作用操作（非只读）。macOS / Linux 有效；其它
 * 平台直接返回 unsupported。
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export type FocusResult =
  | { ok: true; method: 'focused-tab' | 'opened-new' | 'activated-editor' }
  | { ok: false; reason: string };

/** 归一化的宿主编辑器标识（跨平台）。 */
type EditorId = 'code' | 'code-insiders' | 'cursor' | 'windsurf';

/** AppleScript 字符串转义（双引号与反斜杠）。 */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** 某二进制是否在 PATH 上（不启动它，仅探测）。 */
async function hasBin(cmd: string): Promise<boolean> {
  try {
    // cmd 作为位置参数 $1 传入，绝不拼进脚本串——即便来自 $TERMINAL 也无注入面。
    await execFileP('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', cmd], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 沿父进程链向上收集祖先 pid（含自身），由近及远。
 * 用于按「拥有窗口的终端模拟器进程」pid 去聚焦其窗口。
 */
async function ancestorPids(pid: number): Promise<number[]> {
  const pids: number[] = [];
  let cur = pid;
  for (let i = 0; i < 8; i++) {
    pids.push(cur);
    let ppid = '';
    try {
      const { stdout } = await execFileP('ps', ['-o', 'ppid=', '-p', String(cur)], { timeout: 2000 });
      ppid = stdout.trim();
    } catch {
      break;
    }
    const next = Number(ppid);
    if (!Number.isInteger(next) || next <= 1) break;
    cur = next;
  }
  return pids;
}

/**
 * 沿父进程链向上，判断会话宿主的编辑器类型（归一化标识）。
 * 返回 EditorId，或 undefined（普通终端）。
 */
async function hostEditor(pid: number): Promise<EditorId | undefined> {
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
    // 常见编辑器集成终端的进程名特征（Linux 上 comm 可能被截断到 15 字符）。
    if (lower.includes('cursor')) return 'cursor';
    if (lower.includes('code - insiders') || lower.includes('code-insiders')) return 'code-insiders';
    if (lower.includes('code helper') || lower.includes('visual studio code') || /(^|\/)code($|\s)/.test(lower)) {
      return 'code';
    }
    if (lower.includes('windsurf')) return 'windsurf';
    const next = Number(ppid);
    if (!Number.isInteger(next) || next <= 1) return undefined;
    cur = next;
  }
  return undefined;
}

// ————————————————————————————— macOS —————————————————————————————

/** macOS：EditorId → `open -a` 的应用名。 */
function macAppOf(editor: EditorId): string {
  switch (editor) {
    case 'cursor':
      return 'Cursor';
    case 'code-insiders':
      return 'Visual Studio Code - Insiders';
    case 'windsurf':
      return 'Windsurf';
    case 'code':
      return 'Visual Studio Code';
  }
}

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

/** macOS：尝试聚焦 Terminal.app 中 tty 匹配的标签页。成功返回 true。 */
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

/** macOS：在指定目录打开一个新 Terminal 窗口。 */
async function openNewTerminalMac(cwd: string): Promise<boolean> {
  try {
    await execFileP('open', ['-a', 'Terminal', cwd], { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

/** macOS：`open -a <app> <cwd>` 激活编辑器并聚焦该工作目录窗口。 */
async function activateEditorMac(app: string, cwd: string): Promise<boolean> {
  try {
    const args = cwd && cwd.length > 0 ? ['-a', app, cwd] : ['-a', app];
    await execFileP('open', args, { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

async function focusMac(pid: number | null, cwd: string): Promise<FocusResult> {
  if (pid !== null) {
    // 1) 先判断宿主是不是编辑器（VS Code/Cursor 等）。
    const editor = await hostEditor(pid);
    if (editor) {
      const activated = await activateEditorMac(macAppOf(editor), cwd);
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
    const opened = await openNewTerminalMac(cwd);
    if (opened) return { ok: true, method: 'opened-new' };
  }
  return { ok: false, reason: 'no-terminal-found' };
}

// ————————————————————————————— Linux —————————————————————————————

/** Linux：EditorId → CLI 命令名。 */
function linuxCliOf(editor: EditorId): string {
  switch (editor) {
    case 'cursor':
      return 'cursor';
    case 'code-insiders':
      return 'code-insiders';
    case 'windsurf':
      return 'windsurf';
    case 'code':
      return 'code';
  }
}

/**
 * Linux：用编辑器 CLI 聚焦该工作目录窗口。
 * `code <folder>`：若该目录已在某窗口打开则聚焦之，否则打开新窗口——
 * 与 macOS 一样，无法精确定位到集成终端面板（编辑器限制）。
 */
async function activateEditorLinux(cli: string, cwd: string): Promise<boolean> {
  try {
    const args = cwd && cwd.length > 0 ? [cwd] : ['--new-window'];
    // CLI 会把请求转发给已有实例后立即退出；给足超时即可。
    await execFileP(cli, args, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Linux：尝试按祖先进程 pid 聚焦其窗口。
 * 仅在能拿到明确成功信号的环境下返回 true：
 *   - X11（DISPLAY 存在）：xdotool / wmctrl 按 _NET_WM_PID 匹配。
 *   - sway（SWAYSOCK）：swaymsg [pid=..] focus。
 *   - Hyprland（HYPRLAND_INSTANCE_SIGNATURE）：先用 clients -j 确认存在再 dispatch。
 * GNOME+Wayland 无此类接口，本函数必然落空（返回 false），交由上层开新终端兜底。
 *
 * 说明：终端窗口归「终端模拟器进程」所有，而非会话进程本身，故需按祖先 pid
 * 逐个尝试（由近及远，最近的窗口所有者即模拟器）。gnome-terminal 用共享的
 * gnome-terminal-server，其不在会话祖先链上 → 匹配不到 → 落空（符合预期）。
 */
async function tryFocusByPid(pid: number): Promise<boolean> {
  const pids = await ancestorPids(pid);
  if (pids.length === 0) return false;

  // —— X11 / XWayland：按 _NET_WM_PID 匹配窗口 ——
  if (process.env.DISPLAY) {
    if (await hasBin('xdotool')) {
      for (const p of pids) {
        try {
          const { stdout } = await execFileP('xdotool', ['search', '--pid', String(p)], { timeout: 2000 });
          const id = stdout.trim().split(/\s+/).filter(Boolean)[0];
          if (id) {
            await execFileP('xdotool', ['windowactivate', id], { timeout: 2000 });
            return true;
          }
        } catch {
          /* 该 pid 无窗口，继续 */
        }
      }
    }
    if (await hasBin('wmctrl')) {
      try {
        // 输出列：0xID  desktop  pid  host  title
        const { stdout } = await execFileP('wmctrl', ['-l', '-p'], { timeout: 2000 });
        for (const line of stdout.split('\n')) {
          const parts = line.trim().split(/\s+/);
          const wid = parts[0];
          const wpid = Number(parts[2]);
          if (wid && Number.isInteger(wpid) && pids.includes(wpid)) {
            await execFileP('wmctrl', ['-i', '-a', wid], { timeout: 2000 });
            return true;
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  // —— sway ——
  if (process.env.SWAYSOCK && (await hasBin('swaymsg'))) {
    for (const p of pids) {
      try {
        const { stdout } = await execFileP('swaymsg', ['--', `[pid=${p}] focus`], { timeout: 2000 });
        if (/"success"\s*:\s*true/.test(stdout)) return true;
      } catch {
        /* ignore */
      }
    }
  }

  // —— Hyprland ——
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE && (await hasBin('hyprctl'))) {
    try {
      const { stdout } = await execFileP('hyprctl', ['clients', '-j'], { timeout: 2000 });
      const clients = JSON.parse(stdout) as Array<{ pid?: number }>;
      const owned = new Set(clients.map((c) => c.pid).filter((n): n is number => Number.isInteger(n)));
      for (const p of pids) {
        if (owned.has(p)) {
          await execFileP('hyprctl', ['dispatch', 'focuswindow', `pid:${p}`], { timeout: 2000 });
          return true;
        }
      }
    } catch {
      /* ignore */
    }
  }

  return false;
}

/**
 * Linux：在 cwd 开一个新终端窗口。自动挑选可用的模拟器。
 * 同时通过 spawn 的 cwd 设定初始目录，并对已知模拟器附上其工作目录参数
 * （gnome-terminal 走共享 server，不继承 spawn cwd，必须显式传参）。
 */
async function openNewTerminalLinux(cwd: string): Promise<boolean> {
  // [命令, 该命令用于设定工作目录的参数（{d} 占位符替换为 cwd）]。
  // 参数为空数组者：依赖 spawn 的 cwd 选项设定初始目录。
  const candidates: Array<{ cmd: string; args: string[] }> = [];
  const envTerm = process.env.TERMINAL;
  if (envTerm) candidates.push({ cmd: envTerm, args: [] });
  candidates.push(
    { cmd: 'gnome-terminal', args: [`--working-directory=${cwd}`] },
    { cmd: 'kgx', args: [`--working-directory=${cwd}`] },
    { cmd: 'konsole', args: ['--workdir', cwd] },
    { cmd: 'kitty', args: ['--directory', cwd] },
    { cmd: 'alacritty', args: ['--working-directory', cwd] },
    { cmd: 'wezterm', args: ['start', '--cwd', cwd] },
    { cmd: 'foot', args: [`--working-directory=${cwd}`] },
    { cmd: 'xfce4-terminal', args: [`--working-directory=${cwd}`] },
    { cmd: 'tilix', args: [`--working-directory=${cwd}`] },
    { cmd: 'xterm', args: [] },
    { cmd: 'x-terminal-emulator', args: [] },
  );

  for (const { cmd, args } of candidates) {
    if (!(await hasBin(cmd))) continue;
    try {
      const child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore' });
      // ENOENT 等以异步 'error' 事件抛出；已 hasBin 预检，这里兜底避免崩进程。
      child.on('error', () => {});
      child.unref();
      return true;
    } catch {
      /* 尝试下一个 */
    }
  }
  return false;
}

/** 取路径末段（项目名），用于匹配编辑器窗口标题。去掉尾部斜杠。 */
export function basenameOf(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}

/**
 * 从编辑器窗口标题里取「项目名」段。VS Code/Cursor 标题格式为
 *   "<当前文件> - <项目> - Visual Studio Code"（无文件时退化为 "<项目> - Visual Studio Code"）。
 * 项目名恒为「应用名之前的那一段」。故按 " - " 切分，取倒数第二段。
 * 不能用裸子串匹配——项目名可能同时作为「另一个项目里打开的文件名」出现在别的窗口标题里
 * （实测撞名：linux-userspace 项目打开名为 mondo-app 的文件 → 标题含 "mondo-app"）。
 */
export function editorTitleProject(title: string): string {
  const segs = title.replace(/^[●*\s]+/, '').split(' - ');
  if (segs.length < 2) return '';
  return (segs[segs.length - 2] ?? '').trim();
}

/**
 * X11：在编辑器祖先链拥有的顶层窗口里，挑「项目名段 == cwd basename」的那个激活。
 *
 * 为什么按标题的项目名段、而非直接按 pid：一个 VS Code 进程常同时开多个项目窗口
 * （实测 pid 相同、仅标题不同）。按 pid 只会激活第一个匹配窗口，未必是会话 cwd 对应的
 * 项目。故用 wmctrl 读 "0xID desktop pid host title"，在 pid ∈ 祖先链 且 标题项目名段
 * 精确等于 cwd basename 的窗口里命中——实测可 100% 激活正确窗口，且不被撞名文件误导。
 * 仅 X11 有效（Wayland 下 wmctrl 看不到原生客户端）；命中返回 true。
 */
async function tryFocusEditorWindowByCwd(pids: number[], cwd: string): Promise<boolean> {
  if (!process.env.DISPLAY || !cwd) return false;
  const project = basenameOf(cwd).toLowerCase();
  if (!project) return false;
  if (!(await hasBin('wmctrl'))) return false;
  try {
    const { stdout } = await execFileP('wmctrl', ['-l', '-p'], { timeout: 2000 });
    for (const line of stdout.split('\n')) {
      // 前 4 列固定：0xID desktop pid host；其余为标题（可能含空格）。
      const m = line.match(/^(\S+)\s+\S+\s+(\d+)\s+\S+\s+(.*)$/);
      if (!m) continue;
      const wid = m[1]!;
      const wpid = Number(m[2]);
      const title = m[3] ?? '';
      if (
        Number.isInteger(wpid) &&
        pids.includes(wpid) &&
        editorTitleProject(title).toLowerCase() === project
      ) {
        await execFileP('wmctrl', ['-i', '-a', wid], { timeout: 2000 });
        return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

async function focusLinux(pid: number | null, cwd: string): Promise<FocusResult> {
  if (pid !== null) {
    // 1) 宿主是编辑器（VS Code/Cursor…）。
    const editor = await hostEditor(pid);
    if (editor) {
      // 1a) 先用 CLI：把目标项目窗口带到当前工作区（它认得 cwd），必要时新建窗口。
      const cliOk = await activateEditorLinux(linuxCliOf(editor), cwd);
      // 1b) X11 下再按「祖先 pid + cwd 项目名标题」精确激活正确的编辑器窗口，
      //     拿到真实聚焦证据（CLI 的退出码不代表窗口真的到了前台）。
      const pids = await ancestorPids(pid);
      if (await tryFocusEditorWindowByCwd(pids, cwd)) {
        return { ok: true, method: 'activated-editor' };
      }
      // 1c) 无法验证真实聚焦（如 Wayland：wmctrl 看不到原生窗口）。CLI 成功则乐观返回，
      //     行为与旧版一致、不倒退；GNOME+Wayland 仍受显示服务器限制（可能只高亮）。
      if (cliOk) return { ok: true, method: 'activated-editor' };
    }
    // 2) 非编辑器宿主：按 pid 精确聚焦终端窗口（X11 / sway / Hyprland）。
    const focused = await tryFocusByPid(pid);
    if (focused) return { ok: true, method: 'focused-tab' };
  }
  // 3) 降级：在 cwd 开新终端。
  if (cwd && cwd.length > 0) {
    const opened = await openNewTerminalLinux(cwd);
    if (opened) return { ok: true, method: 'opened-new' };
  }
  return { ok: false, reason: 'no-terminal-found' };
}

// ————————————————————————————— 入口 —————————————————————————————

/**
 * 进入会话：把该会话所在的终端/编辑器切到前台。
 * pid 可能为 null（会话已无活进程），此时只能靠 cwd 开新终端。
 */
export async function focusSession(pid: number | null, cwd: string): Promise<FocusResult> {
  if (process.platform === 'darwin') return focusMac(pid, cwd);
  if (process.platform === 'linux') return focusLinux(pid, cwd);
  return { ok: false, reason: 'unsupported-platform' };
}

/**
 * installer.ts — 把 ccmon 的 hook 配置安全合并进 ~/.claude/settings.json。
 *
 * 设计要点：
 *   - 幂等：以命令里的 `CCMON=1` 哨兵子串标记「本工具拥有」的条目；每次合并
 *     先把旧的自有条目清除干净，再追加全新条目 —— 跑两次得到完全一致的结果。
 *   - 无损：绝不动别人的设置 / 别人的 hook（不含哨兵的一律原样保留）。
 *   - 安全：只读写 settings.json；绝不触碰 ~/.claude/ide/*.lock 或
 *     ~/.claude/daemon/control.key。
 *
 * 三个 hook 都是 async:true / timeout:3，用 curl 把 hook 的 stdin JSON 原样
 * POST 到本地守护进程 /hooks。
 */

import { readFile, writeFile } from 'node:fs/promises';
import type { Config } from '../types.ts';

/** 哨兵：既是无害的环境变量赋值，又用于识别本工具写入的条目。 */
const CCMON_SENTINEL = 'CCMON=1';

/** 单个 command hook 对象的形状（保持与 Claude Code settings 一致的宽松类型）。 */
type CommandHook = {
  type: 'command';
  async: true;
  timeout: 3;
  command: string;
};

/** matcher 分组：{ matcher?, hooks:[...] }。 */
type HookGroup = { matcher?: string; hooks: CommandHook[] };

/** 构造投递用的 curl 命令串（带 CCMON=1 哨兵前缀）。 */
function buildCurlCommand(port: number, token?: string): string {
  const authHeader = token && token.length > 0 ? `-H 'Authorization: Bearer ${token}' ` : '';
  return (
    `${CCMON_SENTINEL} curl -sS --max-time 2 ` +
    authHeader +
    `-H 'Content-Type: application/json' --data-binary @- ` +
    `http://127.0.0.1:${port}/hooks`
  );
}

/** 构造单个 command hook 对象。 */
function buildCommandHook(port: number, token?: string): CommandHook {
  return { type: 'command', async: true, timeout: 3, command: buildCurlCommand(port, token) };
}

/**
 * 纯函数：返回待合并进 hooks 的 matcher 分组。
 *   - Notification：两个分组（permission_prompt / idle_prompt）
 *   - Stop：一个分组（无 matcher）
 *   - SessionStart：一个分组（携带 effort.level 等，用于捕获会话真实推理强度）
 */
export function buildHookEntries(
  port: number,
  token?: string,
): { Notification: any[]; Stop: any[]; SessionStart: any[] } {
  const permissionGroup: HookGroup = {
    matcher: 'permission_prompt',
    hooks: [buildCommandHook(port, token)],
  };
  const idleGroup: HookGroup = {
    matcher: 'idle_prompt',
    hooks: [buildCommandHook(port, token)],
  };
  const stopGroup: HookGroup = {
    hooks: [buildCommandHook(port, token)],
  };
  const sessionStartGroup: HookGroup = {
    hooks: [buildCommandHook(port, token)],
  };
  return {
    Notification: [permissionGroup, idleGroup],
    Stop: [stopGroup],
    SessionStart: [sessionStartGroup],
  };
}

/** 判断一个 command 串是否属于本工具（含哨兵）。 */
function commandIsCcmon(cmd: unknown): boolean {
  return typeof cmd === 'string' && cmd.includes(CCMON_SENTINEL);
}

/** 判断一个 hook 对象是否是本工具写入的 command hook。 */
function isCcmonHook(h: unknown): boolean {
  return !!h && typeof h === 'object' && commandIsCcmon((h as Record<string, unknown>).command);
}

/** 清洗单个 event 数组：剔除自有 hook；分组变空则丢弃该分组。 */
function scrubEventArray(arr: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const group of arr) {
    if (group && typeof group === 'object') {
      const g = group as Record<string, unknown>;
      if (Array.isArray(g.hooks)) {
        const kept = g.hooks.filter((h) => !isCcmonHook(h));
        if (kept.length === 0) continue; // 分组已空，丢弃
        out.push({ ...g, hooks: kept });
        continue;
      }
      // 少数情况下分组本身就是 command hook 对象
      if (isCcmonHook(g)) continue;
    }
    out.push(group);
  }
  return out;
}

/**
 * 清洗整个 hooks 对象：逐 event 剔除自有条目；空 event 数组直接删除该键。
 * 返回一个新对象，保留其余键与顺序。
 */
function scrubHooks(hooks: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [event, value] of Object.entries(hooks)) {
    if (Array.isArray(value)) {
      const scrubbed = scrubEventArray(value);
      if (scrubbed.length > 0) out[event] = scrubbed;
      // 空数组：不写回（清理）
    } else {
      out[event] = value; // 非数组：防御性原样保留
    }
  }
  return out;
}

/** 取得一个可安全操作的 hooks 对象副本键。 */
function asHooksObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * 深拷贝 current，清除全部旧的自有条目，再追加全新条目到
 * hooks.Notification[] / hooks.Stop[]。其余设置与他人 hook 原样保留。
 * 幂等：对自身输出再跑一次得到 deep-equal 的结果。
 */
export function computeMergedSettings(current: any, port: number, token?: string): any {
  const base: Record<string, unknown> =
    current && typeof current === 'object' && !Array.isArray(current)
      ? (structuredClone(current) as Record<string, unknown>)
      : {};

  const scrubbed = scrubHooks(asHooksObject(base.hooks));

  const entries = buildHookEntries(port, token);

  const notif = Array.isArray(scrubbed.Notification) ? [...(scrubbed.Notification as unknown[])] : [];
  notif.push(...entries.Notification);
  scrubbed.Notification = notif;

  const stop = Array.isArray(scrubbed.Stop) ? [...(scrubbed.Stop as unknown[])] : [];
  stop.push(...entries.Stop);
  scrubbed.Stop = stop;

  const sessionStart = Array.isArray(scrubbed.SessionStart) ? [...(scrubbed.SessionStart as unknown[])] : [];
  sessionStart.push(...entries.SessionStart);
  scrubbed.SessionStart = sessionStart;

  base.hooks = scrubbed;
  return base;
}

/** 简易 LCS 行 diff，标记 +/-/(空格)。清晰度优先。 */
function lineDiff(a: string[], b: string[]): string[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS 长度 of a[i..], b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push('  ' + a[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push('- ' + a[i]!);
      i++;
    } else {
      out.push('+ ' + b[j]!);
      j++;
    }
  }
  while (i < n) out.push('- ' + a[i++]!);
  while (j < m) out.push('+ ' + b[j++]!);
  return out;
}

/** 生成可读的统一风格 diff 字符串（两侧都 pretty JSON）。 */
export function diffSettings(current: any, next: any): string {
  const a = JSON.stringify(current ?? {}, null, 2).split('\n');
  const b = JSON.stringify(next ?? {}, null, 2).split('\n');
  const body = lineDiff(a, b);
  if (!body.some((l) => l.startsWith('+ ') || l.startsWith('- '))) {
    return '（无变更 / no changes）';
  }
  return ['--- current (settings.json)', '+++ proposed (settings.json)', ...body].join('\n');
}

/** 读取 settings.json；文件缺失或损坏时返回 {}。 */
async function readSettings(path: string): Promise<any> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** 若源文件存在则备份，返回备份路径；否则返回 undefined。 */
async function backupIfExists(path: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined; // 文件不存在，无需备份
  }
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const backupPath = `${path}.ccmon-bak-${stamp}`;
  await writeFile(backupPath, raw, 'utf8');
  return backupPath;
}

/** 以 2 空格缩进 + 结尾换行写出 settings。 */
async function writeSettings(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/** 结构等价（顺序敏感；合并保序，故足够）。 */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 安装 hook。dryRun 时只返回 diff、不落盘。
 * 非 dryRun 且确有变更时：先备份、再写入；无变更则跳过（返回 changed:false）。
 * 绝不读写 ide/*.lock 或 daemon/control.key。
 */
export async function installHooks(
  cfg: Config,
  opts: { dryRun: boolean; port: number; token?: string },
): Promise<{ changed: boolean; backupPath?: string; diff: string }> {
  const current = await readSettings(cfg.settingsPath);
  const next = computeMergedSettings(current, opts.port, opts.token);
  const diff = diffSettings(current, next);

  if (opts.dryRun) return { changed: false, diff };
  if (deepEqual(current, next)) return { changed: false, diff };

  const backupPath = await backupIfExists(cfg.settingsPath);
  await writeSettings(cfg.settingsPath, next);
  return backupPath ? { changed: true, backupPath, diff } : { changed: true, diff };
}

/**
 * 卸载 hook：剔除全部自有条目，清理空的 Notification/Stop 数组与空 hooks 对象。
 * 确有变更时先备份再写入。
 */
export async function uninstallHooks(cfg: Config): Promise<{ changed: boolean; backupPath?: string }> {
  const current = await readSettings(cfg.settingsPath);
  const next: Record<string, unknown> =
    current && typeof current === 'object' && !Array.isArray(current)
      ? (structuredClone(current) as Record<string, unknown>)
      : {};

  if (next.hooks && typeof next.hooks === 'object' && !Array.isArray(next.hooks)) {
    const scrubbed = scrubHooks(next.hooks as Record<string, unknown>);
    if (Object.keys(scrubbed).length === 0) delete next.hooks;
    else next.hooks = scrubbed;
  }

  if (deepEqual(current, next)) return { changed: false };

  const backupPath = await backupIfExists(cfg.settingsPath);
  await writeSettings(cfg.settingsPath, next);
  return backupPath ? { changed: true, backupPath } : { changed: true };
}

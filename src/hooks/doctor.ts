/**
 * doctor.ts — 环境体检。
 *
 * 逐项检查 ~/.claude 结构、Claude CLI 版本、守护进程可达性、hook 是否已装，
 * 并给出 bypassPermissions 的信息提示与安全保证。返回带 ✓/✗/⚠ 前缀的可读行。
 *
 * ok=false 仅当 ~/.claude 或 sessions/ 缺失（其余为警告/提示，不致命）。
 */

import { access, readFile } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { Config } from '../types.ts';

/** claude CLI 支持 idle_prompt / agent_needs_input hook 的最低版本。 */
const MIN_CLAUDE_VERSION = '2.1.198';

const OK = '✓';
const BAD = '✗';
const WARN = '⚠';

/** 检查路径是否存在且可读。 */
async function readable(path: string): Promise<boolean> {
  try {
    await access(path, FS.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** 运行 `claude --version`，超时 3s，best-effort。找不到返回 undefined。 */
function getClaudeVersion(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('claude', ['--version'], { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout) {
        resolve(undefined);
        return;
      }
      resolve(stdout.toString().trim());
    });
  });
}

/** 从输出里抽第一个 x.y.z 三段版本号。 */
function parseVersion(raw: string): [number, number, number] | undefined {
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** a < b 比较三段版本。 */
function versionLessThan(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i]! < b[i]!) return true;
    if (a[i]! > b[i]!) return false;
  }
  return false;
}

/** fetch 守护进程 /health，1s 超时。 */
async function daemonReachable(port: number): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 1000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ac.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 扫描 settings.json 判断是否已安装本工具 hook（找 CCMON=1 哨兵）。 */
async function hooksInstalled(settingsPath: string): Promise<boolean> {
  try {
    const raw = await readFile(settingsPath, 'utf8');
    return raw.includes('CCMON=1');
  } catch {
    return false;
  }
}

/**
 * 执行体检并返回结果行。
 */
export async function runDoctor(cfg: Config): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;

  // —— ~/.claude 结构 ——
  const claudeOk = await readable(cfg.claudeDir);
  lines.push(`${claudeOk ? OK : BAD} ~/.claude 目录：${claudeOk ? cfg.claudeDir : '不存在或不可读'}`);
  if (!claudeOk) ok = false;

  const sessionsOk = await readable(cfg.sessionsDir);
  lines.push(`${sessionsOk ? OK : BAD} sessions/ 目录：${sessionsOk ? '可读' : '不存在或不可读'}`);
  if (!sessionsOk) ok = false;

  const projectsOk = await readable(cfg.projectsDir);
  lines.push(`${projectsOk ? OK : WARN} projects/ 目录：${projectsOk ? '可读' : '不存在（非致命）'}`);

  const settingsOk = await readable(cfg.settingsPath);
  lines.push(`${settingsOk ? OK : WARN} settings.json：${settingsOk ? '可读' : '不存在（安装 hook 时会创建）'}`);

  // —— Claude CLI 版本 ——
  const versionRaw = await getClaudeVersion();
  if (!versionRaw) {
    lines.push(`${WARN} claude CLI：未找到（无法校验版本，非致命）`);
  } else {
    const v = parseVersion(versionRaw);
    if (!v) {
      lines.push(`${WARN} claude CLI：版本无法解析（"${versionRaw}"）`);
    } else if (versionLessThan(v, parseVersion(MIN_CLAUDE_VERSION)!)) {
      lines.push(
        `${WARN} claude CLI：${v.join('.')} < ${MIN_CLAUDE_VERSION}` +
          `（idle_prompt / agent_needs_input hook 需要 ≥ ${MIN_CLAUDE_VERSION}，请升级）`,
      );
    } else {
      lines.push(`${OK} claude CLI：${v.join('.')}（≥ ${MIN_CLAUDE_VERSION}）`);
    }
  }

  // —— 守护进程可达性 ——
  const reachable = await daemonReachable(cfg.port);
  lines.push(
    reachable
      ? `${OK} 守护进程：127.0.0.1:${cfg.port} 可达（/health OK）`
      : `${WARN} 守护进程：127.0.0.1:${cfg.port} 不可达（未启动？先运行 \`ccmon start\`）`,
  );

  // —— hook 是否已安装 ——
  const installed = await hooksInstalled(cfg.settingsPath);
  lines.push(
    installed
      ? `${OK} ccmon hooks：已安装（settings.json 含 CCMON=1 哨兵）`
      : `${WARN} ccmon hooks：未安装（运行 \`ccmon install-hooks\` 写入）`,
  );

  // —— bypassPermissions 信息提示 ——
  lines.push(
    `${WARN} 注意：以 --dangerously-skip-permissions 运行的会话不会触发审批 hook（此时依赖文件 waiting 兜底）。`,
  );

  // —— 安全保证 ——
  lines.push(
    `${OK} 安全：本工具只读写 settings.json；绝不读取 ${join('~', '.claude', 'ide')}/*.lock 或 ${join(
      '~',
      '.claude',
      'daemon',
      'control.key',
    )}。`,
  );

  return { ok, lines };
}

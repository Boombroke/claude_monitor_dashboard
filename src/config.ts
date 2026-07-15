/**
 * config.ts — 配置加载与默认值。
 *
 * 优先级：CLI flags > 环境变量 > ~/.config/ccmon/config.json > 默认值。
 * 本文件是"地基"的一部分，接口已冻结（见 types.ts 的 Config）。
 */

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Config } from './types.ts';
import { SECRET_PATH_DENYLIST } from './types.ts';

/** 用户级配置文件位置（存 token / ntfy topic 等，权限应为 0600）。 */
export function userConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(base, 'ccmon', 'config.json');
}

/** 允许测试用环境变量覆盖 ~/.claude 根，默认真实路径。 */
function resolveClaudeDir(): string {
  const override = process.env.CCMON_CLAUDE_DIR;
  if (override && override.length > 0) return override;
  return join(homedir(), '.claude');
}

const DEFAULTS = {
  host: '127.0.0.1',
  port: 7420,
  lan: false,
  desktopNotifications: true,
  ntfyOnDone: false,
  redact: false,
  maxContextChars: 120,
  hookTtlMs: 30_000,
  idleGraceMs: 60_000,
  deadGraceMs: 3_000,
  stateDebounceMs: 200,
  notifyCooldownMs: 20_000,
} as const;

export interface ConfigOverrides {
  host?: string;
  port?: number;
  lan?: boolean;
  token?: string;
  ntfyTopic?: string;
  ntfyServer?: string;
  redact?: boolean;
}

/** 从磁盘读取用户配置文件（不存在则返回 {}）。 */
function readUserConfig(): Record<string, unknown> {
  const p = userConfigPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * 浅合并 patch 到用户配置文件并持久化（0600）。用于把自动生成的 token / ntfy topic
 * 存下来，使手机订阅/配对在重启后仍然稳定有效。失败静默（不致命）。
 */
export function saveUserConfig(patch: Record<string, unknown>): void {
  try {
    const p = userConfigPath();
    mkdirSync(dirname(p), { recursive: true });
    const current = readUserConfig();
    const next = { ...current, ...patch };
    writeFileSync(p, JSON.stringify(next, null, 2) + '\n', 'utf8');
    chmodSync(p, 0o600);
  } catch {
    /* 持久化失败不致命：本次运行内存里仍有值 */
  }
}

/** 生成一个别人难以猜到的 ntfy topic（ntfy.sh 是公开的，靠不可猜保证隐私）。 */
export function generateNtfyTopic(): string {
  return 'ccmon-' + randomBytes(9).toString('base64url');
}

/**
 * 组装最终 Config。overrides 通常来自 CLI 层解析的 flags。
 * 若开启 lan 但无 token，自动生成一个（调用方负责持久化到 userConfigPath）。
 */
export function loadConfig(overrides: ConfigOverrides = {}): Config {
  const claudeDir = resolveClaudeDir();
  const user = readUserConfig();

  const host = overrides.host ?? (process.env.CCMON_HOST || undefined) ?? (user.host as string | undefined) ?? DEFAULTS.host;
  const lan = overrides.lan ?? (user.lan as boolean | undefined) ?? DEFAULTS.lan;
  const port =
    overrides.port ??
    (process.env.CCMON_PORT ? Number(process.env.CCMON_PORT) : undefined) ??
    (user.port as number | undefined) ??
    DEFAULTS.port;

  // lan 模式强制 token；loopback 下 token 可选。
  const effectiveHost = lan && host === '127.0.0.1' ? '0.0.0.0' : host;
  let token = overrides.token ?? (process.env.CCMON_TOKEN || undefined) ?? (user.token as string | undefined);
  if (lan && (!token || token.length === 0)) {
    token = randomBytes(24).toString('base64url');
  }

  const ntfyTopic = overrides.ntfyTopic ?? (process.env.CCMON_NTFY_TOPIC || undefined) ?? ((user.ntfy as any)?.topic as string | undefined);
  const ntfyServer =
    overrides.ntfyServer ?? (process.env.CCMON_NTFY_SERVER || undefined) ?? ((user.ntfy as any)?.server as string | undefined) ?? 'https://ntfy.sh';

  // 全局默认 effort：读 ~/.claude/settings.json 的 effortLevel（会话未收到 hook 时兜底）。
  let defaultEffort: string | undefined;
  try {
    const s = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')) as Record<string, unknown>;
    if (typeof s.effortLevel === 'string') defaultEffort = s.effortLevel;
  } catch {
    /* 无 settings 或解析失败：无默认 */
  }

  const cfg: Config = {
    claudeDir,
    sessionsDir: join(claudeDir, 'sessions'),
    projectsDir: join(claudeDir, 'projects'),
    jobsDir: join(claudeDir, 'jobs'),
    settingsPath: join(claudeDir, 'settings.json'),

    host: effectiveHost,
    port,
    lan,
    ...(token ? { token } : {}),

    ...(ntfyTopic
      ? {
          ntfy: {
            server: ntfyServer,
            topic: ntfyTopic,
            includeContext: ((user.ntfy as any)?.includeContext as boolean | undefined) ?? false,
          },
        }
      : {}),
    desktopNotifications: (user.desktopNotifications as boolean | undefined) ?? DEFAULTS.desktopNotifications,
    ntfyOnDone: (user.ntfyOnDone as boolean | undefined) ?? DEFAULTS.ntfyOnDone,

    redact: overrides.redact ?? (user.redact as boolean | undefined) ?? DEFAULTS.redact,
    maxContextChars: (user.maxContextChars as number | undefined) ?? DEFAULTS.maxContextChars,
    ...(defaultEffort ? { defaultEffort } : {}),

    hookTtlMs: (user.hookTtlMs as number | undefined) ?? DEFAULTS.hookTtlMs,
    idleGraceMs: (user.idleGraceMs as number | undefined) ?? DEFAULTS.idleGraceMs,
    deadGraceMs: (user.deadGraceMs as number | undefined) ?? DEFAULTS.deadGraceMs,
    stateDebounceMs: (user.stateDebounceMs as number | undefined) ?? DEFAULTS.stateDebounceMs,
    notifyCooldownMs: (user.notifyCooldownMs as number | undefined) ?? DEFAULTS.notifyCooldownMs,
  };

  return cfg;
}

/**
 * 安全断言：给定绝对路径是否落在敏感 denylist 上。
 * watcher 在处理任何文件前必须先过这道关，防止误读 ide/*.lock 或 control.key。
 */
export function isSecretPath(absPath: string): boolean {
  const normalized = absPath.replaceAll('\\', '/');
  return SECRET_PATH_DENYLIST.some((frag) => normalized.includes(frag));
}

/** 截断上下文字符串到配置上限，附省略号。用于 lastPrompt / title / summary。 */
export function truncateContext(s: string | undefined, cfg: Config): string | undefined {
  if (s === undefined) return undefined;
  const max = cfg.maxContextChars;
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

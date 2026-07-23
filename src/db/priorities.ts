/**
 * priorities.ts — 用户手动指派的会话优先级持久化（跨重启/跨设备）。
 *
 * 极简 JSON 文件（非敏感、无需 schema）：{ "<key>": "purple", ... }，
 * key = `${agent}:${sessionId}`。仿 History 的「可选、失败不致命」模式：
 * 构造读盘失败 → 空表；写盘失败 → 忽略（内存仍生效）。
 * 不在会话 remove 时清理 —— 同 key 的会话 --resume 回来可自动恢复其优先级。
 */

import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import type { PriorityLevel } from '../types.ts';
import { PRIORITY_RANK } from '../types.ts';

/** 默认路径（与 ccmon.sqlite / userConfig 同目录）。 */
export function defaultPriorityPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(base, 'ccmon', 'priorities.json');
}

export class PriorityStore {
  private readonly path: string;
  private readonly map = new Map<string, PriorityLevel>();

  constructor(path?: string) {
    this.path = path ?? defaultPriorityPath();
    try {
      const raw = readFileSync(this.path, 'utf8');
      const obj = JSON.parse(raw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && v in PRIORITY_RANK) this.map.set(k, v as PriorityLevel);
      }
    } catch {
      /* 无文件 / 解析失败：降级为空表 */
    }
  }

  get(key: string): PriorityLevel | undefined {
    return this.map.get(key);
  }

  set(key: string, level: PriorityLevel): void {
    this.map.set(key, level);
    this.flush();
  }

  delete(key: string): void {
    if (this.map.delete(key)) this.flush();
  }

  all(): Record<string, PriorityLevel> {
    return Object.fromEntries(this.map);
  }

  private flush(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.all()), 'utf8');
      try {
        chmodSync(this.path, 0o600);
      } catch {
        /* 权限设置失败不致命 */
      }
    } catch {
      /* 写盘失败：内存仍生效，不影响主流程 */
    }
  }
}

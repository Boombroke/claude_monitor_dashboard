/**
 * sessionsWatcher.ts — 监听 ~/.claude/sessions/*.json。
 *
 * 每个活跃会话一个文件，文件名 = pid。add/change 时解析并产出
 * SessionFileSnapshot；unlink 时产出 remove（DEAD 快路径）。
 *
 * 安全：处理任何路径前先过 isSecretPath 断言（虽然 sessions/ 本身不含密钥，
 * 但保持所有 watcher 统一走 denylist，防止未来 glob 误扩展）。
 */

import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { Config, SessionFileSnapshot, Watcher, FileStatus } from '../types.ts';
import { isSecretPath } from '../config.ts';

export interface SessionsWatcherEvents {
  onUpsert: (snap: SessionFileSnapshot) => void;
  /** 文件被删：携带 pid（从文件名解析）。 */
  onRemove: (pid: number) => void;
}

const VALID_STATUS: ReadonlySet<string> = new Set<FileStatus>(['busy', 'idle', 'waiting']);

/** 解析一个 sessions 文件内容为快照；格式异常返回 undefined。 */
export function parseSessionFile(raw: string): SessionFileSnapshot | undefined {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const pid = j.pid;
  const sessionId = j.sessionId;
  const cwd = j.cwd;
  const status = j.status;
  if (typeof pid !== 'number' || typeof sessionId !== 'string' || typeof cwd !== 'string') {
    return undefined;
  }
  const normStatus: FileStatus =
    typeof status === 'string' && VALID_STATUS.has(status) ? (status as FileStatus) : 'idle';

  const snap: SessionFileSnapshot = {
    pid,
    sessionId,
    cwd,
    name: typeof j.name === 'string' ? j.name : sessionId.slice(0, 8),
    status: normStatus,
  };
  // 可选字段透传（存在才写）。
  if (typeof j.nameSource === 'string') snap.nameSource = j.nameSource;
  if (typeof j.waitingFor === 'string') snap.waitingFor = j.waitingFor;
  if (typeof j.version === 'string') snap.version = j.version;
  if (typeof j.kind === 'string') snap.kind = j.kind;
  if (typeof j.entrypoint === 'string') snap.entrypoint = j.entrypoint;
  if (typeof j.startedAt === 'number') snap.startedAt = j.startedAt;
  if (typeof j.procStart === 'string') snap.procStart = j.procStart;
  if (typeof j.updatedAt === 'number') snap.updatedAt = j.updatedAt;
  if (typeof j.statusUpdatedAt === 'number') snap.statusUpdatedAt = j.statusUpdatedAt;
  return snap;
}

/** 从 sessions 文件路径解析 pid（文件名去 .json）。 */
function pidFromPath(p: string): number | undefined {
  const name = basename(p, '.json');
  const n = Number(name);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export class SessionsWatcher implements Watcher {
  private watcher: FSWatcher | undefined;
  private readonly cfg: Config;
  private readonly events: SessionsWatcherEvents;

  constructor(cfg: Config, events: SessionsWatcherEvents) {
    this.cfg = cfg;
    this.events = events;
  }

  async start(): Promise<void> {
    if (this.watcher) return;
    // chokidar v4 移除了 glob 支持：监听目录本身，再按 .json 扩展名过滤。
    this.watcher = chokidar.watch(this.cfg.sessionsDir, {
      ignoreInitial: false, // 启动即读入现有会话
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 20 },
      depth: 0,
      ignored: (p: string) => p !== this.cfg.sessionsDir && !p.endsWith('.json'),
    });
    this.watcher
      .on('add', (p) => void this.handleUpsert(p))
      .on('change', (p) => void this.handleUpsert(p))
      .on('unlink', (p) => this.handleRemove(p));

    await new Promise<void>((resolve) => {
      this.watcher!.on('ready', () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = undefined;
    }
  }

  private async handleUpsert(path: string): Promise<void> {
    if (isSecretPath(path)) return; // denylist 断言
    try {
      const raw = await readFile(path, 'utf8');
      const snap = parseSessionFile(raw);
      if (snap) this.events.onUpsert(snap);
    } catch {
      // 文件可能在读之前被删/半写，忽略本次。
    }
  }

  private handleRemove(path: string): void {
    if (isSecretPath(path)) return;
    const pid = pidFromPath(path);
    if (pid !== undefined) this.events.onRemove(pid);
  }
}

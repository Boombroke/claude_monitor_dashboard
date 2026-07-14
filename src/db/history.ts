/**
 * history.ts — 用 node:sqlite（内置，零依赖零编译）持久化历史。
 *
 * 记录两类：
 *   - 状态转移事件（events 表）：sessionId, at, from_state, to_state, reason
 *   - 通知记录（notifications 表）：sessionId, at, class, title, body
 *
 * 用途：重启后仍可回看某会话的历史时间线与「各状态停留时长」分析。
 * DB 文件默认放在 ~/.config/ccmon/ccmon.sqlite（0600），可被配置覆盖。
 *
 * 设计：同步 API（DatabaseSync）对单用户本地守护进程足够；所有写入都在
 * store 变更/通知回调里调用，量小。任何 DB 错误都被自身捕获，绝不影响主流程。
 */

import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import type { NotificationView, SessionState } from '../types.ts';

export interface HistoryEventRow {
  at: number;
  from_state: string | null;
  to_state: string;
  reason: string | null;
}

export interface HistoryNotificationRow {
  at: number;
  class: string;
  title: string;
  body: string;
}

/** 默认 DB 路径（与 userConfigPath 同目录）。 */
export function defaultHistoryPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(base, 'ccmon', 'ccmon.sqlite');
}

export class History {
  private readonly db: DatabaseSync;
  private readonly insEvent: ReturnType<DatabaseSync['prepare']>;
  private readonly insNotif: ReturnType<DatabaseSync['prepare']>;

  constructor(dbPath?: string) {
    const path = dbPath ?? defaultHistoryPath();
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    // WAL 提升并发读体验；单用户下也无妨。
    try {
      this.db.exec('PRAGMA journal_mode = WAL');
    } catch {
      /* 某些环境（:memory:）不支持，忽略 */
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, at);

      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        class TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notifs_session ON notifications(session_id, at);
    `);
    if (path !== ':memory:') {
      try {
        chmodSync(path, 0o600);
      } catch {
        /* 权限设置失败不致命 */
      }
    }
    this.insEvent = this.db.prepare(
      'INSERT INTO events(session_id, at, from_state, to_state, reason) VALUES(?,?,?,?,?)',
    );
    this.insNotif = this.db.prepare(
      'INSERT INTO notifications(session_id, at, class, title, body) VALUES(?,?,?,?,?)',
    );
  }

  /** 记录一次状态转移。 */
  recordTransition(
    sessionId: string,
    at: number,
    from: SessionState | undefined,
    to: SessionState,
    reason?: string,
  ): void {
    try {
      this.insEvent.run(sessionId, at, from ?? null, to, reason ?? null);
    } catch {
      /* DB 错误不影响主流程 */
    }
  }

  /** 记录一条通知。 */
  recordNotification(view: NotificationView): void {
    try {
      this.insNotif.run(view.sessionId, view.createdAt, view.class, view.title, view.body);
    } catch {
      /* ignore */
    }
  }

  /** 查某会话最近 N 条状态事件（时间升序）。 */
  eventsFor(sessionId: string, limit = 200): HistoryEventRow[] {
    try {
      const rows = this.db
        .prepare(
          'SELECT at, from_state, to_state, reason FROM events WHERE session_id=? ORDER BY at DESC LIMIT ?',
        )
        .all(sessionId, limit) as unknown as HistoryEventRow[];
      return rows.reverse();
    } catch {
      return [];
    }
  }

  /** 查某会话最近 N 条通知（时间升序）。 */
  notificationsFor(sessionId: string, limit = 100): HistoryNotificationRow[] {
    try {
      const rows = this.db
        .prepare('SELECT at, class, title, body FROM notifications WHERE session_id=? ORDER BY at DESC LIMIT ?')
        .all(sessionId, limit) as unknown as HistoryNotificationRow[];
      return rows.reverse();
    } catch {
      return [];
    }
  }

  /**
   * 各状态累计停留时长（毫秒）——按事件相邻时间差归到 from_state。
   * 用于「时间去哪了」分析。仅统计有 from_state 的相邻转移。
   */
  stateDurations(sessionId: string): Record<string, number> {
    const rows = this.eventsFor(sessionId, 10_000);
    const out: Record<string, number> = {};
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1]!;
      const cur = rows[i]!;
      const dur = cur.at - prev.at;
      if (dur > 0) out[prev.to_state] = (out[prev.to_state] ?? 0) + dur;
    }
    return out;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

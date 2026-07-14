/**
 * notifier.ts — 通知编排：状态转移 → 决策 → 去重 → 存在感抑制 → 限流/合并 → 扇出。
 *
 * onTransition 同步返回 void；内部 fire-and-forget 异步处理（存在感检测、渠道投递）。
 *
 * 规则：
 *   - 进入 NEEDS_APPROVAL / IDLE_INPUT → needs-you（high）
 *   - 进入 DONE_WAITING → done（default）
 *   - WORKING→DEAD → info（low，「工作中退出」）
 *   - 进入 WORKING / IDLE / 其他 → 不通知
 *   去重：key = sessionId:state:bucket，冷却期内或状态未变则丢弃。
 *   存在感抑制：仅桌面渠道；ntfy 永不因在场被抑制（needs-you 离机通道）。
 *   限流：每渠道令牌桶（5s 窗口）；4s 内 ≥3 会话进 needs-you → 合并成一条汇总。
 */

import type {
  Config,
  Notification,
  NotificationChannel,
  NotificationClass,
  NotificationPriority,
  NotificationView,
  Notifier as NotifierInterface,
  Session,
  SessionState,
} from '../types.ts';
import { truncateContext } from '../config.ts';
import { isUserPresentAtSession } from './presence.ts';

export interface NotifierOptions {
  now?: () => number;
  broadcast?: (view: NotificationView) => void;
  /** 存在感检测（可注入以便测试）。默认 isUserPresentAtSession。 */
  presence?: (pid: number | null) => Promise<boolean>;
}

/** 每渠道令牌桶配置：窗口内最多发 capacity 条。 */
const BUCKET_WINDOW_MS = 5_000;
const BUCKET_CAPACITY = 1;
/** needs-you 合并窗口。 */
const COALESCE_WINDOW_MS = 4_000;
const COALESCE_THRESHOLD = 3;

interface TokenBucket {
  windowStart: number;
  count: number;
}

export class Notifier implements NotifierInterface {
  private readonly cfg: Config;
  private readonly channels: NotificationChannel[];
  private readonly now: () => number;
  private readonly broadcast: ((view: NotificationView) => void) | undefined;
  private readonly presence: (pid: number | null) => Promise<boolean>;

  /** 去重：notifyKey → 上次发送时间。 */
  private readonly lastSent = new Map<string, number>();
  /** 每渠道令牌桶。 */
  private readonly buckets = new Map<string, TokenBucket>();
  /** needs-you 合并缓冲：等待窗口内累积的会话名。 */
  private coalesceBuffer: { at: number; names: string[]; timer: NodeJS.Timeout } | undefined;

  constructor(cfg: Config, channels: NotificationChannel[], opts: NotifierOptions = {}) {
    this.cfg = cfg;
    this.channels = channels;
    this.now = opts.now ?? Date.now;
    this.broadcast = opts.broadcast;
    this.presence = opts.presence ?? isUserPresentAtSession;
  }

  onTransition(session: Session, from: SessionState | undefined): void {
    const spec = this.classify(session, from);
    if (!spec) return;
    // fire-and-forget；onTransition 同步返回。
    void this.handle(session, spec);
  }

  // ── 决策 ──────────────────────────────────────────────────────────────

  private classify(
    session: Session,
    from: SessionState | undefined,
  ): { class: NotificationClass; priority: NotificationPriority; title: string; tags: string[] } | undefined {
    const name = session.name || session.sessionId.slice(0, 8);
    switch (session.state) {
      case 'NEEDS_APPROVAL':
        return { class: 'needs-you', priority: 'high', title: `🔐 ${name} 需要审批`, tags: ['warning', 'lock'] };
      case 'IDLE_INPUT':
        return { class: 'needs-you', priority: 'high', title: `💬 ${name} 在等你`, tags: ['speech_balloon'] };
      case 'DONE_WAITING':
        return { class: 'done', priority: 'default', title: `✅ ${name} 完成一轮`, tags: ['white_check_mark'] };
      case 'DEAD':
        if (from === 'WORKING') {
          return { class: 'info', priority: 'low', title: `⚠️ ${name} 工作中退出`, tags: ['warning'] };
        }
        return undefined;
      default:
        return undefined; // WORKING / IDLE 等：不通知
    }
  }

  /** 构造正文：redact 时只显 state+project；否则含截断的 title/prompt。 */
  private buildBody(session: Session, forNtfy: boolean): string {
    const stateProject = `${session.state} · ${session.project || session.cwd || ''}`.trim();
    if (this.cfg.redact) return stateProject;
    // ntfy 是否包含上下文由 cfg.ntfy.includeContext 决定；桌面总是可含。
    if (forNtfy && !(this.cfg.ntfy?.includeContext ?? false)) return stateProject;
    const ctx = truncateContext(session.currentTitle ?? session.lastPrompt, this.cfg);
    return ctx ? `${stateProject}\n${ctx}` : stateProject;
  }

  // ── 处理 ──────────────────────────────────────────────────────────────

  private async handle(
    session: Session,
    spec: { class: NotificationClass; priority: NotificationPriority; title: string; tags: string[] },
  ): Promise<void> {
    const at = this.now();
    const bucket = Math.floor(at / this.cfg.notifyCooldownMs);
    const key = `${session.sessionId}:${session.state}:${bucket}`;

    // 去重：冷却期内同键丢弃。
    const prev = this.lastSent.get(key);
    if (prev !== undefined && at - prev < this.cfg.notifyCooldownMs) return;
    this.lastSent.set(key, at);
    this.pruneDedup(at);

    // needs-you 合并：窗口内累积，达到阈值发汇总、抑制单条。
    if (spec.class === 'needs-you' && this.tryCoalesce(session, at)) {
      // 已加入合并缓冲；单条不立即发（由合并定时器统一处理）。
      // 但仍广播单条 view 给前端（UI 需要即时反映）。
      this.emitView(session, spec, this.buildBody(session, false));
      return;
    }

    await this.dispatch(session, spec);
  }

  /** 真正扇出到各渠道（含存在感抑制、限流）。 */
  private async dispatch(
    session: Session,
    spec: { class: NotificationClass; priority: NotificationPriority; title: string; tags: string[] },
  ): Promise<void> {
    // 前端 view（不受渠道限流/抑制影响）。
    this.emitView(session, spec, this.buildBody(session, false));

    // 桌面存在感抑制：用户在场则跳过桌面（ntfy 不受影响）。
    let suppressDesktop = false;
    if (spec.class !== 'info') {
      try {
        suppressDesktop = await this.presence(session.pid);
      } catch {
        suppressDesktop = false;
      }
    }

    for (const ch of this.channels) {
      const n: Notification = {
        key: `${session.sessionId}:${session.state}`,
        sessionId: session.sessionId,
        class: spec.class,
        priority: spec.priority,
        title: spec.title,
        body: this.buildBody(session, ch.name === 'ntfy'),
        tags: spec.tags,
        project: session.project || '',
        state: session.state,
        createdAt: this.now(),
      };
      if (!ch.handles(n)) continue;
      if (ch.name === 'desktop' && suppressDesktop) continue;
      if (!this.takeToken(ch.name)) continue; // 限流
      void ch.send(n);
    }
  }

  /** 合并逻辑：把会话名加入缓冲；达到阈值时发一条汇总。返回是否已纳入合并（抑制单条渠道投递）。 */
  private tryCoalesce(session: Session, at: number): boolean {
    const name = session.name || session.sessionId.slice(0, 8);
    if (!this.coalesceBuffer) {
      // 开一个合并窗口；到期后按累积数量决定发单条还是汇总。
      const timer = setTimeout(() => this.flushCoalesce(), COALESCE_WINDOW_MS);
      timer.unref?.();
      this.coalesceBuffer = { at, names: [name], timer };
      return false; // 窗口内第一条：不纳入合并，正常发单条
    }
    this.coalesceBuffer.names.push(name);
    return this.coalesceBuffer.names.length >= COALESCE_THRESHOLD;
  }

  /** 合并窗口到期：若累积 ≥ 阈值发汇总，否则不额外发（首条已单发）。 */
  private flushCoalesce(): void {
    const buf = this.coalesceBuffer;
    this.coalesceBuffer = undefined;
    if (!buf) return;
    if (buf.names.length < COALESCE_THRESHOLD) return; // 首条已发，无需汇总

    const n: Notification = {
      key: `coalesced:${Math.floor(buf.at / COALESCE_WINDOW_MS)}`,
      sessionId: '',
      class: 'needs-you',
      priority: 'high',
      title: `${buf.names.length} 个会话需要你`,
      body: buf.names.join('、'),
      tags: ['bell'],
      project: '',
      state: 'IDLE_INPUT',
      createdAt: this.now(),
    };
    for (const ch of this.channels) {
      if (!ch.handles(n)) continue;
      if (!this.takeToken(ch.name)) continue;
      void ch.send(n);
    }
    if (this.broadcast) {
      this.broadcast({ sessionId: '', class: 'needs-you', title: n.title, body: n.body, createdAt: n.createdAt });
    }
  }

  private emitView(
    session: Session,
    spec: { class: NotificationClass; title: string },
    body: string,
  ): void {
    if (!this.broadcast) return;
    this.broadcast({
      sessionId: session.sessionId,
      class: spec.class,
      title: spec.title,
      body,
      createdAt: this.now(),
    });
  }

  // ── 限流 / 清理 ────────────────────────────────────────────────────────

  /** 令牌桶：窗口内允许 BUCKET_CAPACITY 条，超出返回 false。 */
  private takeToken(channel: string): boolean {
    const at = this.now();
    let b = this.buckets.get(channel);
    if (!b || at - b.windowStart >= BUCKET_WINDOW_MS) {
      b = { windowStart: at, count: 0 };
      this.buckets.set(channel, b);
    }
    if (b.count >= BUCKET_CAPACITY) return false;
    b.count++;
    return true;
  }

  /** 清理过期去重记录，避免无限增长。 */
  private pruneDedup(at: number): void {
    const ttl = this.cfg.notifyCooldownMs * 4;
    for (const [k, t] of this.lastSent) {
      if (at - t > ttl) this.lastSent.delete(k);
    }
  }
}

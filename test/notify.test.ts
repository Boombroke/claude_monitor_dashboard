/**
 * notify.test.ts — Notifier 单测（node:test）。
 * 用假渠道记录投递，注入 now() 与 presence，验证分类路由/去重/存在感抑制。
 * 不触网、不真跑 osascript。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Notifier } from '../src/notify/notifier.ts';
import { loadConfig } from '../src/config.ts';
import type { Notification, NotificationChannel, Session, SessionState } from '../src/types.ts';

/** 记录型假渠道。 */
class FakeChannel implements NotificationChannel {
  readonly name: string;
  readonly sent: Notification[] = [];
  private readonly accept: (n: Notification) => boolean;
  constructor(name: string, accept: (n: Notification) => boolean) {
    this.name = name;
    this.accept = accept;
  }
  handles(n: Notification): boolean {
    return this.accept(n);
  }
  send(n: Notification): Promise<boolean> {
    this.sent.push(n);
    return Promise.resolve(true);
  }
}

function makeSession(state: SessionState, over: Partial<Session> = {}): Session {
  const sessionId = over.sessionId ?? 'sid-1';
  return {
    sessionId,
    agent: over.agent ?? 'claude',
    key: over.key ?? `claude:${sessionId}`,
    pid: 111,
    pastPids: [],
    name: over.name ?? 'proj-a',
    cwd: '/x/proj-a',
    project: 'proj-a',
    state,
    isBackground: false,
    startedAt: 0,
    lastActivityAt: 0,
    stateSince: 0,
    isAlive: true,
    needsAttention: state === 'NEEDS_APPROVAL' || state === 'IDLE_INPUT' || state === 'DONE_WAITING',
    events: [],
    ...over,
  };
}

/** 造一个 now 可控、presence 恒 false（不在场）的 Notifier + 渠道。 */
function setup(opts: { present?: boolean } = {}) {
  let t = 1_000_000;
  const now = () => t;
  const advance = (ms: number) => {
    t += ms;
  };
  const desktop = new FakeChannel('desktop', () => true);
  const ntfy = new FakeChannel('ntfy', (n) => n.class === 'needs-you');
  const cfg = loadConfig({});
  const notifier = new Notifier(cfg, [desktop, ntfy], {
    now,
    presence: () => Promise.resolve(opts.present ?? false),
  });
  return { notifier, desktop, ntfy, advance, cfg };
}

test('NEEDS_APPROVAL 同时发桌面与 ntfy', async () => {
  const { notifier, desktop, ntfy } = setup();
  notifier.onTransition(makeSession('NEEDS_APPROVAL'), 'WORKING');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(desktop.sent.length, 1);
  assert.equal(ntfy.sent.length, 1);
  assert.equal(desktop.sent[0]!.class, 'needs-you');
  assert.equal(desktop.sent[0]!.priority, 'high');
});

test('DONE_WAITING 只发桌面，不发 ntfy（默认 ntfyOnDone=false）', async () => {
  const { notifier, desktop, ntfy } = setup();
  notifier.onTransition(makeSession('DONE_WAITING'), 'WORKING');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(desktop.sent.length, 1);
  assert.equal(desktop.sent[0]!.class, 'done');
  assert.equal(ntfy.sent.length, 0);
});

test('WORKING / IDLE 不发通知', async () => {
  const { notifier, desktop, ntfy } = setup();
  notifier.onTransition(makeSession('WORKING'), 'IDLE');
  notifier.onTransition(makeSession('IDLE'), 'DONE_WAITING');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(desktop.sent.length, 0);
  assert.equal(ntfy.sent.length, 0);
});

test('冷却期内重复同状态被去重', async () => {
  const { notifier, desktop } = setup();
  const s = makeSession('NEEDS_APPROVAL');
  notifier.onTransition(s, 'WORKING');
  await new Promise((r) => setTimeout(r, 10));
  // 同会话同状态，冷却期内再次转移（模拟抖动）→ 不重复。
  notifier.onTransition(s, 'WORKING');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(desktop.sent.length, 1);
});

test('存在感抑制：在场时桌面被抑制，ntfy 仍发', async () => {
  const { notifier, desktop, ntfy } = setup({ present: true });
  notifier.onTransition(makeSession('NEEDS_APPROVAL'), 'WORKING');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(desktop.sent.length, 0, '在场应抑制桌面');
  assert.equal(ntfy.sent.length, 1, 'ntfy 不受在场抑制');
});

test('WORKING→DEAD 发 info（仅桌面，ntfy 不收 info）', async () => {
  const { notifier, desktop, ntfy } = setup();
  notifier.onTransition(makeSession('DEAD'), 'WORKING');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(desktop.sent.length, 1);
  assert.equal(desktop.sent[0]!.class, 'info');
  assert.equal(ntfy.sent.length, 0);
});

test('IDLE→DEAD 不发通知（非工作中退出）', async () => {
  const { notifier, desktop } = setup();
  notifier.onTransition(makeSession('DEAD'), 'IDLE');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(desktop.sent.length, 0);
});

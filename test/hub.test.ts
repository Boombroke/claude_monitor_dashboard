/**
 * hub.test.ts — Hub（内核提交引擎）单测：复合 key、去抖、扇出。
 * 用假 notifier + 记录型 broadcast/onStateTransition，注入短去抖窗口。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySessionStore } from '../src/core/store.ts';
import { Hub, keyOf } from '../src/core/hub.ts';
import { loadConfig } from '../src/config.ts';
import type { Notifier, ServerEvent, Session, SessionState } from '../src/types.ts';

function setup(debounceMs = 30) {
  const store = new InMemorySessionStore();
  const events: ServerEvent[] = [];
  const transitions: Array<{ key: string; to: SessionState }> = [];
  const notified: Array<{ key: string; from: SessionState | undefined }> = [];
  const notifier: Notifier = {
    onTransition: (s: Session, from) => notified.push({ key: s.key, from }),
  };
  const cfg = { ...loadConfig({}), stateDebounceMs: debounceMs };
  const hub = new Hub({
    cfg,
    store,
    notifier,
    broadcast: (e) => events.push(e),
    onStateTransition: (s, from) => transitions.push({ key: s.key, to: s.state }),
  });
  return { store, hub, events, transitions, notified };
}

test('makeSink.patch 注入 agent + 复合 key 并广播 update', () => {
  const { hub, store, events } = setup();
  hub.makeSink('claude').patch('s1', { cwd: '/x', name: 'demo' });
  const s = store.get(keyOf('claude', 's1'));
  assert.ok(s);
  assert.equal(s.agent, 'claude');
  assert.equal(s.sessionId, 's1');
  assert.equal(s.key, 'claude:s1');
  assert.ok(events.some((e) => e.type === 'session.update'));
});

test('WORKING 立即提交；IDLE 去抖后才提交', async () => {
  const { hub, store } = setup(30);
  const sink = hub.makeSink('claude');
  sink.patch('s1', { cwd: '/x' });
  sink.setState('s1', 'WORKING');
  assert.equal(store.get('claude:s1')?.state, 'WORKING');
  sink.setState('s1', 'IDLE');
  assert.equal(store.get('claude:s1')?.state, 'WORKING');
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(store.get('claude:s1')?.state, 'IDLE');
});

test('markDead 立即 DEAD 并触发 onStateTransition + notifier', () => {
  const { hub, store, transitions, notified } = setup();
  const sink = hub.makeSink('claude');
  sink.patch('s1', { cwd: '/x' });
  sink.setState('s1', 'WORKING');
  sink.markDead('s1', '进程已退出');
  assert.equal(store.get('claude:s1')?.state, 'DEAD');
  assert.ok(transitions.some((t) => t.to === 'DEAD'));
  assert.ok(notified.some((n) => n.key === 'claude:s1'));
});

test('不同 agent 相同 sessionId 不串键', () => {
  const { hub, store } = setup();
  hub.makeSink('claude').patch('dup', { cwd: '/a' });
  hub.makeSink('codex').patch('dup', { cwd: '/b' });
  assert.equal(store.get('claude:dup')?.cwd, '/a');
  assert.equal(store.get('codex:dup')?.cwd, '/b');
  assert.equal(store.all().length, 2);
});

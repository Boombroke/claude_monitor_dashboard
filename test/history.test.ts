/**
 * history.test.ts — History(node:sqlite) 单测，用 :memory: DB。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { History } from '../src/db/history.ts';

test('记录并回读状态转移（时间升序）', () => {
  const h = new History(':memory:');
  h.recordTransition('s1', 1000, undefined, 'IDLE');
  h.recordTransition('s1', 2000, 'IDLE', 'WORKING', '工作中');
  h.recordTransition('s1', 5000, 'WORKING', 'DONE_WAITING', '完成一轮');
  const rows = h.eventsFor('s1');
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.to_state, 'IDLE');
  assert.equal(rows[1]!.from_state, 'IDLE');
  assert.equal(rows[2]!.to_state, 'DONE_WAITING');
  assert.equal(rows[2]!.reason, '完成一轮');
  h.close();
});

test('状态时长按相邻转移归到 from 状态', () => {
  const h = new History(':memory:');
  h.recordTransition('s2', 1000, undefined, 'IDLE');
  h.recordTransition('s2', 2000, 'IDLE', 'WORKING'); // IDLE 停留 1000ms
  h.recordTransition('s2', 5000, 'WORKING', 'IDLE'); // WORKING 停留 3000ms
  const d = h.stateDurations('s2');
  assert.equal(d.IDLE, 1000);
  assert.equal(d.WORKING, 3000);
  h.close();
});

test('记录并回读通知', () => {
  const h = new History(':memory:');
  h.recordNotification({ sessionId: 's3', class: 'needs-you', title: '需要审批', body: 'x', createdAt: 100 });
  h.recordNotification({ sessionId: 's3', class: 'done', title: '完成', body: 'y', createdAt: 200 });
  const rows = h.notificationsFor('s3');
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.title, '需要审批');
  assert.equal(rows[1]!.class, 'done');
  h.close();
});

test('会话隔离：不同 session 互不串', () => {
  const h = new History(':memory:');
  h.recordTransition('a', 1, undefined, 'IDLE');
  h.recordTransition('b', 1, undefined, 'WORKING');
  assert.equal(h.eventsFor('a').length, 1);
  assert.equal(h.eventsFor('b').length, 1);
  assert.equal(h.eventsFor('a')[0]!.to_state, 'IDLE');
  h.close();
});

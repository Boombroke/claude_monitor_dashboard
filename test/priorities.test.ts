import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PriorityStore } from '../src/db/priorities.ts';
import { InMemorySessionStore } from '../src/core/store.ts';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'ccmon-prio-'));
  return { dir, file: join(dir, 'priorities.json') };
}

test('PriorityStore：set/get/delete 往返落盘', () => {
  const { dir, file } = tmp();
  try {
    const ps = new PriorityStore(file);
    assert.equal(ps.get('claude:abc'), undefined);
    ps.set('claude:abc', 'purple');
    assert.equal(ps.get('claude:abc'), 'purple');
    // 重新读盘 → 持久化生效
    assert.equal(new PriorityStore(file).get('claude:abc'), 'purple');
    ps.delete('claude:abc');
    assert.equal(new PriorityStore(file).get('claude:abc'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PriorityStore：读盘过滤非法档位', () => {
  const { dir, file } = tmp();
  try {
    writeFileSync(file, JSON.stringify({ 'a:b': 'chartreuse', 'c:d': 'blue' }));
    const ps = new PriorityStore(file);
    assert.equal(ps.get('a:b'), undefined); // 非法 → 丢弃
    assert.equal(ps.get('c:d'), 'blue');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('store.hydrate 回填 priority；状态流转与内容 patch 均不覆盖', () => {
  const store = new InMemorySessionStore({
    hydrate: (k) => (k === 'claude:s1' ? { priority: 'blue' } : undefined),
  });
  const s = store.upsert('claude:s1', {
    agent: 'claude',
    sessionId: 's1',
    key: 'claude:s1',
    state: 'WORKING',
  });
  assert.equal(s.priority, 'blue'); // hydrate 回填
  store.setState('claude:s1', 'IDLE'); // 状态流转不带 priority
  assert.equal(store.get('claude:s1')!.priority, 'blue');
  store.upsert('claude:s1', { lastPrompt: 'hi' }); // 内容 patch 不带 priority
  assert.equal(store.get('claude:s1')!.priority, 'blue');
});

test('store：priority patch 显式写入优先于 hydrate；null 语义由路由层处理', () => {
  const store = new InMemorySessionStore({
    hydrate: (k) => (k === 'claude:s3' ? { priority: 'white' } : undefined),
  });
  // 显式 patch 提供 priority → 优先于 hydrate
  const s = store.upsert('claude:s3', {
    agent: 'claude',
    sessionId: 's3',
    key: 'claude:s3',
    state: 'WORKING',
    priority: 'purple',
  });
  assert.equal(s.priority, 'purple');
});

test('store：remove 后重建经 hydrate 恢复 priority', () => {
  const store = new InMemorySessionStore({
    hydrate: (k) => (k === 'claude:s2' ? { priority: 'purple' } : undefined),
  });
  store.upsert('claude:s2', { agent: 'claude', sessionId: 's2', key: 'claude:s2', state: 'DEAD' });
  store.remove('claude:s2');
  const again = store.upsert('claude:s2', {
    agent: 'claude',
    sessionId: 's2',
    key: 'claude:s2',
    state: 'WORKING',
  });
  assert.equal(again.priority, 'purple'); // 重建恢复
});

/**
 * opencode.test.ts — OpencodeProvider 单测：事件映射（纯函数）+ onPush 经假 sink。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpencodeProvider } from '../src/providers/opencode/provider.ts';
import { mapOpencodeEvent } from '../src/providers/opencode/mapEvent.ts';
import { loadConfig } from '../src/config.ts';
import type { SessionSink } from '../src/providers/types.ts';
import type { Session, SessionState } from '../src/types.ts';

test('mapOpencodeEvent: 事件/状态 → 归一化', () => {
  assert.equal(mapOpencodeEvent({ sessionID: 's', event: 'session.status', status: 'busy' }, undefined)?.state, 'WORKING');
  assert.equal(mapOpencodeEvent({ sessionID: 's', event: 'permission.asked' }, 'WORKING')?.state, 'NEEDS_APPROVAL');
  assert.equal(mapOpencodeEvent({ sessionID: 's', event: 'question.asked' }, 'WORKING')?.state, 'IDLE_INPUT');
  assert.equal(mapOpencodeEvent({ sessionID: 's', event: 'session.status', status: 'idle' }, 'WORKING')?.state, 'DONE_WAITING');
  assert.equal(mapOpencodeEvent({ sessionID: 's', event: 'session.idle' }, 'IDLE_INPUT')?.state, 'IDLE');
  const retry = mapOpencodeEvent({ sessionID: 's', event: 'session.status', status: 'retry' }, 'WORKING');
  assert.equal(retry?.state, 'WORKING');
  assert.equal(retry?.detail, '重试中');
  assert.equal(mapOpencodeEvent({ sessionID: 's', event: 'session.deleted' }, 'WORKING')?.dead, true);
  assert.equal(mapOpencodeEvent({ event: 'session.idle' }, undefined), undefined);
  assert.equal(mapOpencodeEvent({ sessionID: 's', event: 'session.updated', directory: '/a/proj' }, undefined)?.patch.name, 'proj');
});

function fakeSink() {
  const store = new Map<string, { patch: Record<string, unknown>; state?: SessionState }>();
  const ensure = (id: string) => {
    let s = store.get(id);
    if (!s) {
      s = { patch: {} };
      store.set(id, s);
    }
    return s;
  };
  const sink: SessionSink = {
    now: () => Date.now(),
    peek: (id) => {
      const s = store.get(id);
      if (!s) return undefined;
      return { sessionId: id, agent: 'opencode', key: `opencode:${id}`, state: s.state ?? 'IDLE', ...s.patch } as unknown as Session;
    },
    patch: (id, p) => {
      Object.assign(ensure(id).patch, p);
    },
    setState: (id, st) => {
      ensure(id).state = st;
    },
    markDead: (id) => {
      ensure(id).state = 'DEAD';
    },
  };
  return { sink, store };
}

test('OpencodeProvider.onPush: busy→WORKING → permission→NEEDS_APPROVAL → idle→IDLE', async () => {
  const { sink, store } = fakeSink();
  const p = new OpencodeProvider(loadConfig({}));
  await p.start(sink);
  p.onPush({ sessionID: 'ses_x', event: 'session.status', status: 'busy', directory: '/tmp/proj' });
  assert.equal(store.get('ses_x')?.state, 'WORKING');
  assert.equal(store.get('ses_x')?.patch.name, 'proj');
  p.onPush({ sessionID: 'ses_x', event: 'permission.asked' });
  assert.equal(store.get('ses_x')?.state, 'NEEDS_APPROVAL');
  p.onPush({ sessionID: 'ses_x', event: 'session.status', status: 'idle' });
  assert.equal(store.get('ses_x')?.state, 'IDLE');
  await p.stop();
});

test('OpencodeProvider.onPush: busy 然后 idle → DONE_WAITING', async () => {
  const { sink, store } = fakeSink();
  const p = new OpencodeProvider(loadConfig({}));
  await p.start(sink);
  p.onPush({ sessionID: 'ses_y', event: 'session.status', status: 'busy' });
  p.onPush({ sessionID: 'ses_y', event: 'session.idle' });
  assert.equal(store.get('ses_y')?.state, 'DONE_WAITING');
  await p.stop();
});

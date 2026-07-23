/**
 * codex.test.ts — CodexProvider 单测：状态推导（纯函数）+ rollout 解析 + 引导集成。
 * fixture rollout 写入临时 codexHome，绝不触碰真实 ~/.codex。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexProvider } from '../src/providers/codex/provider.ts';
import { reduceCodexState, parseRolloutLine } from '../src/providers/codex/rollout.ts';
import { loadConfig } from '../src/config.ts';
import type { SessionSink } from '../src/providers/types.ts';
import type { Session, SessionState } from '../src/types.ts';

test('reduceCodexState: event_msg → 状态', () => {
  assert.equal(reduceCodexState(undefined, 'task_started'), 'WORKING');
  assert.equal(reduceCodexState('WORKING', 'exec_approval_request'), 'NEEDS_APPROVAL');
  assert.equal(reduceCodexState('WORKING', 'apply_patch_approval_request'), 'NEEDS_APPROVAL');
  assert.equal(reduceCodexState('WORKING', 'request_user_input'), 'IDLE_INPUT');
  assert.equal(reduceCodexState('WORKING', 'task_complete'), 'DONE_WAITING');
  assert.equal(reduceCodexState('WORKING', 'turn_aborted'), 'DONE_WAITING');
  assert.equal(reduceCodexState('WORKING', 'shutdown_complete'), 'DEAD');
  // 阻塞态遇后续活动事件 → 恢复 WORKING
  assert.equal(reduceCodexState('NEEDS_APPROVAL', 'patch_apply_end'), 'WORKING');
  assert.equal(reduceCodexState('IDLE_INPUT', 'agent_message'), 'WORKING');
  // WORKING 遇普通活动事件 → 不变
  assert.equal(reduceCodexState('WORKING', 'token_count'), undefined);
});

test('parseRolloutLine: 合法 / 非法', () => {
  const ok = parseRolloutLine('{"type":"event_msg","timestamp":"t","payload":{"type":"task_started"}}');
  assert.deepEqual(ok, { type: 'event_msg', timestamp: 't', payload: { type: 'task_started' } });
  assert.equal(parseRolloutLine('not json'), undefined);
  assert.equal(parseRolloutLine('{"no":"type"}'), undefined);
});

function fakeSink() {
  const store = new Map<string, { patch: Record<string, unknown>; state?: SessionState; dead?: boolean }>();
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
      return { sessionId: id, agent: 'codex', key: `codex:${id}`, state: s.state ?? 'IDLE', ...s.patch } as unknown as Session;
    },
    patch: (id, p) => {
      Object.assign(ensure(id).patch, p);
    },
    setState: (id, st) => {
      ensure(id).state = st;
    },
    markDead: (id) => {
      const s = ensure(id);
      s.state = 'DEAD';
      s.dead = true;
    },
  };
  return { sink, store };
}

const line = (o: unknown): string => JSON.stringify(o) + '\n';

test('CodexProvider 引导：读出 rollout 当前状态与上下文', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ccmon-codex-'));
  try {
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    const dir = join(home, 'sessions', String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
    mkdirSync(dir, { recursive: true });
    const ts = d.toISOString();
    const content =
      line({ type: 'session_meta', timestamp: ts, payload: { id: 'codex-sess-1', cwd: '/tmp/proj', git: { branch: 'main' } } }) +
      line({ type: 'turn_context', timestamp: ts, payload: { model: 'gpt-5.5', effort: 'xhigh', cwd: '/tmp/proj' } }) +
      line({ type: 'event_msg', timestamp: ts, payload: { type: 'task_started' } }) +
      line({ type: 'event_msg', timestamp: ts, payload: { type: 'token_count', info: { model_context_window: 200000, last_token_usage: { input_tokens: 5000 } } } }) +
      line({ type: 'event_msg', timestamp: ts, payload: { type: 'agent_message', message: 'hello from codex' } }) +
      line({ type: 'event_msg', timestamp: ts, payload: { type: 'task_complete' } });
    writeFileSync(join(dir, 'rollout-x-codex-sess-1.jsonl'), content);

    const cfg = loadConfig({});
    const { sink, store } = fakeSink();
    const provider = new CodexProvider(cfg, { codexHome: home });
    await provider.start(sink);
    await provider.stop();

    const s = store.get('codex-sess-1');
    assert.ok(s, '应发现 codex 会话');
    assert.equal(s.state, 'DONE_WAITING');
    assert.equal(s.patch.model, 'gpt-5.5');
    assert.equal(s.patch.effort, 'xhigh');
    assert.equal(s.patch.contextWindow, 200000);
    assert.equal(s.patch.contextTokens, 5000);
    assert.equal(s.patch.name, 'proj');
    assert.equal(s.patch.gitBranch, 'main');
    assert.equal(s.patch.lastAssistantSummary, 'hello from codex');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('CodexProvider 引导：审批事件 → NEEDS_APPROVAL', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ccmon-codex-'));
  try {
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    const dir = join(home, 'sessions', String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
    mkdirSync(dir, { recursive: true });
    const ts = d.toISOString();
    const content =
      line({ type: 'session_meta', timestamp: ts, payload: { id: 'codex-2', cwd: '/tmp/a' } }) +
      line({ type: 'event_msg', timestamp: ts, payload: { type: 'task_started' } }) +
      line({ type: 'event_msg', timestamp: ts, payload: { type: 'exec_approval_request' } });
    writeFileSync(join(dir, 'rollout-x-codex-2.jsonl'), content);

    const { sink, store } = fakeSink();
    const provider = new CodexProvider(loadConfig({}), { codexHome: home });
    await provider.start(sink);
    await provider.stop();

    assert.equal(store.get('codex-2')?.state, 'NEEDS_APPROVAL');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

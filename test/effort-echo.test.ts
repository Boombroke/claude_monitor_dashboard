/**
 * effort-echo.test.ts — /effort 回显提取（区分 ultracode 的核心逻辑）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEffortEcho } from '../src/watch/transcriptTailer.ts';

const wrap = (content: unknown, over: Record<string, unknown> = {}) => ({
  type: 'user',
  isSidechain: false,
  message: { role: 'user', content },
  ...over,
});

test('提取 ultracode 档名', () => {
  const rec = wrap(
    '<local-command-stdout>Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration</local-command-stdout>',
  );
  assert.equal(extractEffortEcho(rec), 'ultracode');
});

test('提取 xhigh / max / high', () => {
  assert.equal(extractEffortEcho(wrap('<local-command-stdout>Set effort level to xhigh, saved as default</local-command-stdout>')), 'xhigh');
  assert.equal(extractEffortEcho(wrap('Set effort level to max (this session only): Maximum capability')), 'max');
  assert.equal(extractEffortEcho(wrap('Set effort level to high')), 'high');
});

test('sidechain（子代理）回显被排除', () => {
  const rec = wrap('Set effort level to ultracode', { isSidechain: true });
  assert.equal(extractEffortEcho(rec), undefined);
});

test('message.content 为数组（tool_result 假回显）被排除', () => {
  const rec = wrap([{ type: 'tool_result', content: 'Set effort level to max' }]);
  assert.equal(extractEffortEcho(rec), undefined);
});

test('非 user 记录被排除', () => {
  assert.equal(extractEffortEcho({ type: 'assistant', message: { content: 'Set effort level to max' } }), undefined);
});

test('无关 user 消息返回 undefined', () => {
  assert.equal(extractEffortEcho(wrap('帮我改一下代码')), undefined);
});

test('非对象/缺字段安全', () => {
  assert.equal(extractEffortEcho(null), undefined);
  assert.equal(extractEffortEcho('x'), undefined);
  assert.equal(extractEffortEcho({ type: 'user' }), undefined);
  assert.equal(extractEffortEcho({ type: 'user', message: null }), undefined);
});

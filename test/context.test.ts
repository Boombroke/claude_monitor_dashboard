/**
 * context.test.ts — 上下文 token 计算 + 窗口推断（防回归重点）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeContextTokens, inferContextWindow } from '../src/watch/transcriptTailer.ts';

test('computeContextTokens：四项求和', () => {
  assert.equal(
    computeContextTokens({
      input_tokens: 2,
      cache_creation_input_tokens: 295,
      cache_read_input_tokens: 425348,
      output_tokens: 688,
    }),
    426333,
  );
});

test('computeContextTokens：缺字段/非对象/全 0 → undefined 或部分和', () => {
  assert.equal(computeContextTokens(null), undefined);
  assert.equal(computeContextTokens('x'), undefined);
  assert.equal(computeContextTokens({}), undefined);
  assert.equal(computeContextTokens({ input_tokens: 0, output_tokens: 0 }), undefined);
  assert.equal(computeContextTokens({ input_tokens: 100 }), 100);
  // 负数/非有限按 0
  assert.equal(computeContextTokens({ input_tokens: -5, output_tokens: 50 }), 50);
});

test('inferContextWindow：[1m] 标记 → 1M', () => {
  assert.equal(inferContextWindow('us.anthropic.claude-opus-4-8[1m]', 5000), 1_000_000);
});

test('inferContextWindow：已知原生 1M 模型族 → 1M（即使 token 还少）', () => {
  assert.equal(inferContextWindow('claude-sonnet-5', 3000), 1_000_000);
  assert.equal(inferContextWindow('claude-opus-4-8', 1000), 1_000_000);
});

test('inferContextWindow：防回归——441K 的 sonnet 会话必是 1M（不 >100%）', () => {
  // sonnet-5 本就是 1M 族；即便判族失败，441K>200K 也兜底为 1M。
  assert.equal(inferContextWindow('claude-sonnet-5', 441424), 1_000_000);
  // 假设一个未知模型名，靠 token 兜底
  assert.equal(inferContextWindow('some-unknown-model', 441424), 1_000_000);
});

test('inferContextWindow：未知模型且 token 少 → 200K', () => {
  assert.equal(inferContextWindow('some-old-200k-model', 5000), 200_000);
  assert.equal(inferContextWindow(undefined, 5000), 200_000);
});

test('inferContextWindow：恰好 200K 不触发 1M（边界）', () => {
  assert.equal(inferContextWindow('unknown', 200_000), 200_000);
  assert.equal(inferContextWindow('unknown', 200_001), 1_000_000);
});

/**
 * subagentWatcher.test.ts — 子代理 token 足迹 + workflow 活动采集。
 * 用临时 claudeDir 造 <slug>/<sid>/subagents/[workflows/wf_x/]agent-*.jsonl，
 * 直接 refresh() 驱动 sweep，收集 onStats。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubagentWatcher } from '../src/watch/subagentWatcher.ts';
import type { Config, SubagentStats } from '../src/types.ts';

function makeCfg(projectsDir: string): Config {
  return {
    claudeDir: '/tmp/x',
    sessionsDir: '/tmp/x/sessions',
    projectsDir,
    jobsDir: '/tmp/x/jobs',
    settingsPath: '/tmp/x/settings.json',
    host: '127.0.0.1',
    port: 7420,
    lan: false,
    desktopNotifications: false,
    ntfyOnDone: false,
    redact: false,
    maxContextChars: 120,
    hookTtlMs: 30000,
    idleGraceMs: 60000,
    deadGraceMs: 3000,
    stateDebounceMs: 200,
    notifyCooldownMs: 20000,
  };
}

/** 造一个 agent-*.jsonl，内容为若干带 usage 的 assistant 记录。 */
function writeAgent(path: string, peaks: number[], synthTail = false): void {
  const lines = peaks.map((p) =>
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: p } } }),
  );
  if (synthTail) {
    // 收尾 synthetic-0 记录（四项全 0）。
    lines.push(JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 0 } } }));
  }
  writeFileSync(path, lines.join('\n') + '\n');
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ccmon-sub-'));
  const cfg = makeCfg(root);
  const collected: SubagentStats[] = [];
  let t = 1_000_000;
  const watcher = new SubagentWatcher(cfg, {
    onStats: (s) => collected.push(s),
    now: () => t,
  });
  return { root, cfg, watcher, collected, advance: (ms: number) => (t += ms), setNow: (v: number) => (t = v) };
}

test('peak 取 max、忽略末条 synthetic-0', async () => {
  const { root, watcher, collected } = setup();
  const sid = 'sess-1';
  const sub = join(root, 'slug-a', sid, 'subagents');
  mkdirSync(sub, { recursive: true });
  writeAgent(join(sub, 'agent-1.jsonl'), [1000, 41047, 30000], true); // peak=41047，末条 synthetic-0
  await watcher.refresh(sid); // 未 track，refresh 无效
  watcher.track(sid, join(root, 'slug-a')); // cwd 使 slug=slug-a
  await watcher.refresh(sid);
  const last = collected.at(-1);
  assert.ok(last, '应有 stats');
  assert.equal(last.subagentTokens, 41047);
  assert.equal(last.agentCount, 1);
  watcher.untrack(sid);
  rmSync(root, { recursive: true, force: true });
});

test('顶层 + workflow 子代理都计入；workflowAgentCount 只数 wf 内', async () => {
  const { root, watcher, collected } = setup();
  const sid = 'sess-2';
  const sub = join(root, 'slug-b', sid, 'subagents');
  const wf = join(sub, 'workflows', 'wf_aaa');
  mkdirSync(wf, { recursive: true });
  writeAgent(join(sub, 'agent-top.jsonl'), [5000]); // 顶层
  writeAgent(join(wf, 'agent-w1.jsonl'), [3000]);
  writeAgent(join(wf, 'agent-w2.jsonl'), [2000]);
  writeFileSync(join(wf, 'journal.jsonl'), '{"type":"result"}\n');
  watcher.track(sid, join(root, 'slug-b'));
  await watcher.refresh(sid);
  const last = collected.at(-1)!;
  assert.equal(last.subagentTokens, 10000, '5000+3000+2000');
  assert.equal(last.agentCount, 3, '顶层 1 + wf 2');
  assert.equal(last.workflowCount, 1);
  assert.equal(last.workflowAgentCount, 2, '只数 wf 内');
  watcher.untrack(sid);
  rmSync(root, { recursive: true, force: true });
});

test('scripts/ 目录不计入 workflowCount', async () => {
  const { root, watcher, collected } = setup();
  const sid = 'sess-3';
  const wfRoot = join(root, 'slug-c', sid, 'subagents', 'workflows');
  mkdirSync(join(wfRoot, 'wf_xxx'), { recursive: true });
  mkdirSync(join(wfRoot, 'scripts'), { recursive: true });
  writeAgent(join(wfRoot, 'wf_xxx', 'agent-1.jsonl'), [1000]);
  writeFileSync(join(wfRoot, 'scripts', 'foo.js'), 'noise');
  watcher.track(sid, join(root, 'slug-c'));
  await watcher.refresh(sid);
  assert.equal(collected.at(-1)!.workflowCount, 1, '只认 wf_*');
  watcher.untrack(sid);
  rmSync(root, { recursive: true, force: true });
});

test('跨 slug 按 sessionId 合并', async () => {
  const { root, watcher, collected } = setup();
  const sid = 'sess-4';
  const subA = join(root, 'slug-a', sid, 'subagents');
  const subB = join(root, 'slug-b', sid, 'subagents');
  mkdirSync(subA, { recursive: true });
  mkdirSync(join(subB, 'workflows', 'wf_z'), { recursive: true });
  writeAgent(join(subA, 'agent-1.jsonl'), [4000]);
  writeAgent(join(subB, 'workflows', 'wf_z', 'agent-2.jsonl'), [6000]);
  watcher.track(sid, join(root, 'slug-a'));
  await watcher.refresh(sid);
  const last = collected.at(-1)!;
  assert.equal(last.subagentTokens, 10000, '跨 slug 相加');
  assert.equal(last.agentCount, 2);
  assert.equal(last.workflowCount, 1);
  watcher.untrack(sid);
  rmSync(root, { recursive: true, force: true });
});

test('无变化不重复 emit（签名去抖）', async () => {
  const { root, watcher, collected } = setup();
  const sid = 'sess-5';
  const sub = join(root, 'slug-a', sid, 'subagents');
  mkdirSync(sub, { recursive: true });
  writeAgent(join(sub, 'agent-1.jsonl'), [1000]);
  watcher.track(sid, join(root, 'slug-a'));
  await watcher.refresh(sid);
  const n1 = collected.length;
  await watcher.refresh(sid); // 无变化
  assert.equal(collected.length, n1, '签名未变，不再 emit');
  watcher.untrack(sid);
  rmSync(root, { recursive: true, force: true });
});

test('workflowActive 随 mtime 新鲜度自愈', async () => {
  const { root, watcher, collected, setNow } = setup();
  const sid = 'sess-6';
  const wf = join(root, 'slug-a', sid, 'subagents', 'workflows', 'wf_a');
  mkdirSync(wf, { recursive: true });
  writeAgent(join(wf, 'agent-1.jsonl'), [1000]);
  // now 设在文件 mtime 附近 → active
  setNow(Date.now() + 1000);
  watcher.track(sid, join(root, 'slug-a'));
  await watcher.refresh(sid);
  assert.equal(collected.at(-1)!.workflowActive, true, '新鲜 → active');
  // now 推进到 90s 之后 → 下次 sweep active 翻 false（自愈）
  setNow(Date.now() + 200_000);
  await watcher.refresh(sid);
  assert.equal(collected.at(-1)!.workflowActive, false, '越窗 → 自愈为 false');
  watcher.untrack(sid);
  rmSync(root, { recursive: true, force: true });
});

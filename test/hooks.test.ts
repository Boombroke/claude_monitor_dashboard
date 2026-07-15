/**
 * hooks.test.ts — installer 纯函数单测（node:test + node:assert）。
 *
 * 只测纯函数（computeMergedSettings / buildHookEntries / diffSettings）；
 * 绝不写真实 ~/.claude，不触碰磁盘 I/O（installHooks 不在此覆盖）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHookEntries, computeMergedSettings, diffSettings } from '../src/hooks/installer.ts';

const PORT = 7420;

/** 收集设置里所有 command 串，便于断言。 */
function allCommands(settings: any): string[] {
  const out: string[] = [];
  const hooks = settings?.hooks ?? {};
  for (const arr of Object.values(hooks)) {
    if (!Array.isArray(arr)) continue;
    for (const group of arr) {
      for (const h of group?.hooks ?? []) {
        if (typeof h?.command === 'string') out.push(h.command);
      }
    }
  }
  return out;
}

test('computeMergedSettings({}, port) 产出 3 个分组（Notification x2 + Stop x1）', () => {
  const merged = computeMergedSettings({}, PORT);
  assert.ok(Array.isArray(merged.hooks.Notification));
  assert.ok(Array.isArray(merged.hooks.Stop));
  assert.equal(merged.hooks.Notification.length, 2);
  assert.equal(merged.hooks.Stop.length, 1);

  const matchers = merged.hooks.Notification.map((g: any) => g.matcher);
  assert.deepEqual(matchers, ['permission_prompt', 'idle_prompt']);
  assert.equal(merged.hooks.Stop[0].matcher, undefined);

  // 每个 hook 形状正确
  for (const cmd of allCommands(merged)) {
    assert.match(cmd, /^CCMON=1 curl -sS --max-time 2 /);
    assert.match(cmd, /http:\/\/127\.0\.0\.1:7420\/hooks$/);
  }
  const first = merged.hooks.Stop[0].hooks[0];
  assert.equal(first.type, 'command');
  assert.equal(first.async, true);
  assert.equal(first.timeout, 3);
});

test('幂等：对自身输出再跑一次得到 deep-equal 结果', () => {
  const once = computeMergedSettings({}, PORT);
  const twice = computeMergedSettings(once, PORT);
  assert.deepEqual(twice, once);
  // command 数量不翻倍（Notification×2 + Stop×1 + SessionStart×1 = 4）
  assert.equal(allCommands(twice).length, 4);
});

test('保留无关设置与他人 hook，并在其旁追加自有条目', () => {
  const existing = {
    model: 'x',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
    },
  };
  const merged = computeMergedSettings(existing, PORT);

  // 无关顶层字段保留
  assert.equal(merged.model, 'x');
  // 他人的 PreToolUse 原样保留
  assert.deepEqual(merged.hooks.PreToolUse, existing.hooks.PreToolUse);
  // 追加了自有条目
  assert.equal(merged.hooks.Notification.length, 2);
  assert.equal(merged.hooks.Stop.length, 1);
  assert.equal(merged.hooks.SessionStart.length, 1);
  // 未改动原对象（深拷贝）
  assert.equal((existing.hooks as any).Notification, undefined);
});

test('已存在的 ccmon 条目被替换而非重复', () => {
  const stale = computeMergedSettings({}, 9999); // 旧端口的自有条目
  assert.ok(allCommands(stale).every((c) => c.includes(':9999/')));

  const merged = computeMergedSettings(stale, PORT);
  const cmds = allCommands(merged);
  // 无重复：仍是 4 条
  assert.equal(cmds.length, 4);
  // 全部指向新端口，旧端口条目已清除
  assert.ok(cmds.every((c) => c.includes(':7420/')));
  assert.ok(!cmds.some((c) => c.includes(':9999/')));
});

test('清除自有条目时保留同 event 下他人 hook', () => {
  // Notification 里既有他人 hook，又有旧的 ccmon hook
  const mixed = {
    hooks: {
      Notification: [
        { matcher: 'other', hooks: [{ type: 'command', command: 'echo other' }] },
        { matcher: 'permission_prompt', hooks: [{ type: 'command', command: 'CCMON=1 curl old' }] },
      ],
    },
  };
  const merged = computeMergedSettings(mixed, PORT);
  const notifCmds = merged.hooks.Notification.flatMap((g: any) => g.hooks.map((h: any) => h.command));
  // 他人条目保留
  assert.ok(notifCmds.includes('echo other'));
  // 旧的 ccmon 条目被移除
  assert.ok(!notifCmds.some((c: string) => c.includes('CCMON=1 curl old')));
  // 新的 ccmon 条目（2 个 Notification 分组）追加
  const ccmonNotif = notifCmds.filter((c: string) => c.includes('CCMON=1'));
  assert.equal(ccmonNotif.length, 2);
});

test('token 变体在命令串里含 Authorization 头；无 token 变体省略', () => {
  const withToken = buildHookEntries(PORT, 'secret-tok');
  const cmdWith = withToken.Stop[0].hooks[0].command as string;
  assert.match(cmdWith, /-H 'Authorization: Bearer secret-tok'/);

  const noToken = buildHookEntries(PORT);
  const cmdNo = noToken.Stop[0].hooks[0].command as string;
  assert.ok(!cmdNo.includes('Authorization'));

  // 空字符串 token 视为无 token
  const emptyTok = buildHookEntries(PORT, '');
  assert.ok(!(emptyTok.Stop[0].hooks[0].command as string).includes('Authorization'));
});

test('diffSettings 对无变更返回明确提示；对有变更含 +/- 行', () => {
  const same = diffSettings({ a: 1 }, { a: 1 });
  assert.match(same, /无变更|no changes/);

  const merged = computeMergedSettings({}, PORT);
  const d = diffSettings({}, merged);
  assert.ok(d.includes('+ ') || d.split('\n').some((l) => l.startsWith('+')));
  assert.match(d, /CCMON=1/);
});

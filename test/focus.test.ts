import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basenameOf, editorTitleProject } from '../src/server/focus.ts';

test('basenameOf：取路径末段，容忍尾部斜杠', () => {
  assert.equal(basenameOf('/home/pc/x/mondo-app'), 'mondo-app');
  assert.equal(basenameOf('/home/pc/x/mondo-app/'), 'mondo-app');
  assert.equal(basenameOf('/home/pc/x/mondo-app///'), 'mondo-app');
  assert.equal(basenameOf('mondo-app'), 'mondo-app');
  assert.equal(basenameOf('/'), '');
});

test('editorTitleProject：项目名恒为应用名前一段（"<文件> - <项目> - App"）', () => {
  // 有当前文件：项目在倒数第二段。
  assert.equal(
    editorTitleProject('README.md - mondo-app - Visual Studio Code'),
    'mondo-app',
  );
  // 无文件（单文件段）：项目在倒数第二段。
  assert.equal(
    editorTitleProject('linux-userspace - Visual Studio Code'),
    'linux-userspace',
  );
  // 脏标记 ● 前缀应被剥离。
  assert.equal(
    editorTitleProject('● app.ts - mondo-app - Visual Studio Code'),
    'mondo-app',
  );
});

test('editorTitleProject：撞名不误判——项目名作为别处文件名出现时不匹配', () => {
  // linux-userspace 项目里打开了名为 "mondo-app" 的文件：项目段应为 linux-userspace，
  // 绝不能被误判成 mondo-app（这正是裸子串匹配会踩的坑）。
  const title = '● mondo-app - linux-userspace - Visual Studio Code';
  assert.equal(editorTitleProject(title), 'linux-userspace');
  assert.notEqual(editorTitleProject(title).toLowerCase(), 'mondo-app');
});

test('editorTitleProject：非编辑器/异常标题返回空串（不匹配任何项目）', () => {
  assert.equal(editorTitleProject('Visual Studio Code'), ''); // 单段
  assert.equal(editorTitleProject(''), '');
});

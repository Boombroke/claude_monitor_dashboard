/**
 * providers/opencode/plugin.ts — 随 ccmon 分发的 opencode 转发插件（源码 + 安装器）。
 *
 * 插件放到 ~/.config/opencode/plugin/ 下由 opencode 自动加载；它订阅 event 钩子，
 * 把会话状态/审批/提问事件 POST 到本地 ccmon 的 /ingest/opencode。
 * 源码内不使用模板字符串，以便安全地嵌入本 TS 文件。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export const OPENCODE_PLUGIN_SOURCE = `// ccmon opencode 转发插件（由 \`ccmon install-opencode-plugin\` 写入）。
// 把 opencode 会话事件转发给本地 ccmon 守护进程；best-effort，失败静默。
export const CcmonForwarder = async ({ directory }) => {
  const env = (globalThis.process && globalThis.process.env) || {};
  const base = env.CCMON_URL || 'http://127.0.0.1:7420';
  const token = env.CCMON_TOKEN;
  const post = (body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    body.directory = directory;
    try {
      fetch(base + '/ingest/opencode', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2000),
      }).catch(function () {});
    } catch (e) {}
  };
  return {
    event: async ({ event }) => {
      const p = (event && event.properties) || {};
      const sid = p.sessionID || p.sessionId;
      if (!sid) return;
      const t = event.type;
      if (t === 'session.status') post({ sessionID: sid, event: 'session.status', status: p.status && p.status.type });
      else if (t === 'session.idle') post({ sessionID: sid, event: 'session.idle' });
      else if (t === 'permission.asked') post({ sessionID: sid, event: 'permission.asked' });
      else if (t === 'question.asked') post({ sessionID: sid, event: 'question.asked' });
      else if (t === 'session.deleted') post({ sessionID: sid, event: 'session.deleted' });
      else if (t === 'session.updated') post({ sessionID: sid, event: 'session.updated' });
    },
  };
};
`;

/** opencode 全局插件目录（XDG）。 */
export function opencodePluginDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(base, 'opencode', 'plugin');
}

/** 幂等写入转发插件；内容一致则跳过。 */
export function installOpencodePlugin(): { path: string; changed: boolean } {
  const dir = opencodePluginDir();
  const path = join(dir, 'ccmon-forwarder.js');
  if (existsSync(path)) {
    try {
      if (readFileSync(path, 'utf8') === OPENCODE_PLUGIN_SOURCE) return { path, changed: false };
    } catch {
      /* 读失败则重写 */
    }
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, OPENCODE_PLUGIN_SOURCE, 'utf8');
  return { path, changed: true };
}

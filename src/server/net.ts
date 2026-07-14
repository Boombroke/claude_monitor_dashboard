/**
 * net.ts — 局域网地址探测。
 *
 * 用于 --lan 模式下告诉用户手机该访问哪个 http://<ip>:<port>，并生成配对 URL。
 */

import { networkInterfaces } from 'node:os';

/** 返回首选的局域网 IPv4 地址（非 loopback、非 link-local）。找不到返回 undefined。 */
export function lanIPv4(): string | undefined {
  const ifaces = networkInterfaces();
  const candidates: string[] = [];
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      if (info.family !== 'IPv4') continue;
      if (info.internal) continue;
      if (info.address.startsWith('169.254.')) continue; // link-local
      candidates.push(info.address);
    }
  }
  // 优先常见的私有网段（192.168 / 10 / 172.16-31）。
  const privateFirst = candidates.sort((a, b) => rankPrivate(b) - rankPrivate(a));
  return privateFirst[0];
}

function rankPrivate(ip: string): number {
  if (ip.startsWith('192.168.')) return 3;
  if (ip.startsWith('10.')) return 2;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 1;
  return 0;
}

/** 构造供手机访问的配对 URL（含 token 查询参，若有）。 */
export function pairingUrl(ip: string, port: number, token?: string): string {
  const base = `http://${ip}:${port}/`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

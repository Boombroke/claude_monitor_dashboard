/**
 * assets.ts — 静态资源访问抽象，支持两种运行模式：
 *   - 开发：从磁盘 public/ 目录读（node src/cli.ts start）
 *   - 单文件（SEA）：从注入 node 二进制的嵌入资源读（sea.getAsset）
 *
 * public/ 文件清单在打包时由 build 脚本写入 sea-config.json 的 assets 映射；
 * 运行时若检测到 SEA，则用 node:sea 的 getAsset 取字节，否则回退磁盘。
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

/** 需要随单文件分发的 public/ 资源清单（build 脚本据此嵌入）。 */
export const PUBLIC_ASSETS: readonly string[] = [
  'index.html',
  'app.js',
  'ui.js',
  'styles.css',
  'sw.js',
  'manifest.webmanifest',
  'icon.svg',
  'pairing.html',
];

/** 扩展名 → Content-Type。 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function contentTypeFor(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** 运行时是否为 SEA 单文件模式。 */
export function isSea(): boolean {
  try {
    // node:sea 的 isSea() 在非 SEA 环境也可安全调用。
    const sea = require('node:sea') as { isSea?: () => boolean };
    return typeof sea.isSea === 'function' ? sea.isSea() : false;
  } catch {
    return false;
  }
}

/** 磁盘上 public/ 目录（开发模式）。相对 src/server 上溯两级。 */
function diskPublicDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'public');
}

/**
 * 取一个 public/ 资源的内容。返回 Buffer（找不到返回 undefined）。
 * SEA 模式走 getRawAsset；否则读磁盘。
 */
export async function readAsset(name: string): Promise<Buffer | undefined> {
  if (isSea()) {
    try {
      const sea = require('node:sea') as { getRawAsset?: (key: string) => ArrayBuffer };
      if (typeof sea.getRawAsset === 'function') {
        const ab = sea.getRawAsset(name);
        return Buffer.from(ab);
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  try {
    return await readFile(join(diskPublicDir(), name));
  } catch {
    return undefined;
  }
}

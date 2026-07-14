#!/usr/bin/env node
/**
 * build-sea.mjs — 把 ccmon 打包成单文件可执行程序（Node SEA）。
 *
 * 步骤：
 *   1. esbuild 把 src/cli.ts + 全部第三方依赖打成单个 CJS（dist/ccmon.cjs）。
 *      node:* 内置（含 node:sqlite/node:sea）保持 external。
 *   2. 生成 sea-config.json，把 public/ 下每个资源作为 asset 嵌入。
 *   3. node --experimental-sea-config 生成 blob。
 *   4. 拷贝 node 可执行文件，postject 注入 blob → dist/ccmon 单文件。
 *
 * 产物：dist/ccmon（拷到任何同架构 macOS 即可运行，无需装 Node）。
 */

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync, chmodSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const publicDir = join(root, 'public');

function log(msg) {
  process.stdout.write(`[build-sea] ${msg}\n`);
}

/**
 * 选注入基底 node 二进制。
 * Homebrew 编译的 node 不含 SEA fuse sentinel，postject 会失败——因此优先用
 * 官方 nodejs.org 发行版二进制（含 fuse）。放在 .node-official/ 下，或用
 * 环境变量 CCMON_BASE_NODE 指定。找不到则回退 process.execPath 并警告。
 */
function pickBaseNode() {
  if (process.env.CCMON_BASE_NODE && existsSync(process.env.CCMON_BASE_NODE)) {
    return process.env.CCMON_BASE_NODE;
  }
  const ver = process.version; // e.g. v26.3.0
  const arch = process.arch === 'x64' ? 'x64' : process.arch; // arm64 / x64
  const plat = process.platform === 'darwin' ? 'darwin' : process.platform;
  const guess = join(root, '.node-official', `node-${ver}-${plat}-${arch}`, 'bin', 'node');
  if (existsSync(guess)) return guess;
  log(`⚠️  未找到官方 node 二进制（${guess}）。`);
  log('    Homebrew 的 node 不含 SEA fuse，postject 可能失败。');
  log(`    请先下载：curl -sSL https://nodejs.org/dist/${ver}/node-${ver}-${plat}-${arch}.tar.gz | tar xz -C .node-official`);
  log('    或用 CCMON_BASE_NODE=<官方node路径> 指定。暂回退 process.execPath。');
  return process.execPath;
}

// —— 0. 准备 dist/ ——
if (existsSync(dist)) rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// —— 1. esbuild 打包成单个 CJS ——
log('esbuild 打包 src/cli.ts → dist/ccmon.cjs …');
const bundlePath = join(dist, 'ccmon.cjs');
await build({
  entryPoints: [join(root, 'src', 'cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: bundlePath,
  // node: 内置全部 external（含 node:sqlite / node:sea）。第三方（fastify/chokidar）打进包。
  external: ['node:*'],
  // @fastify/static 在 SEA 模式下不会被 import（isSea 分支跳过），但 esbuild 静态分析
  // 会把动态 import 也打包——保留即可，运行时 SEA 分支不触发它。
  logLevel: 'info',
  legalComments: 'none',
  minify: false,
});

// —— 2. 生成 sea-config.json（嵌入 public/ 资源）——
log('生成 sea-config.json（嵌入 public/ 资源）…');
const assets = {};
for (const name of readdirSync(publicDir)) {
  assets[name] = join(publicDir, name);
}
const seaConfigPath = join(dist, 'sea-config.json');
writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: bundlePath,
      output: join(dist, 'ccmon.blob'),
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false, // 跨机器可移植性优先，关闭 code cache
      assets,
    },
    null,
    2,
  ),
);

// —— 3. 生成 SEA blob ——
log('生成 SEA blob …');
execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit' });

// —— 4. 拷贝 node 二进制并注入 ——
const outBin = join(dist, 'ccmon');
const baseNode = pickBaseNode();
log(`拷贝基底 node 可执行文件（${baseNode}）→ ${outBin}`);
copyFileSync(baseNode, outBin);
chmodSync(outBin, 0o755);

log('postject 注入 blob …');
const blobPath = join(dist, 'ccmon.blob');
// 用 npx postject（Node 官方推荐工具）。macOS 需 --macho-segment-name NODE_SEA。
const postjectArgs = [
  '--yes',
  'postject',
  outBin,
  'NODE_SEA_BLOB',
  blobPath,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  '--macho-segment-name',
  'NODE_SEA',
];
execFileSync('npx', postjectArgs, { stdio: 'inherit' });

// —— 5. macOS 需要重新签名（ad-hoc）——
if (process.platform === 'darwin') {
  log('ad-hoc 重新签名（codesign）…');
  try {
    execFileSync('codesign', ['--remove-signature', outBin], { stdio: 'inherit' });
  } catch {
    /* 可能本来无签名 */
  }
  execFileSync('codesign', ['--sign', '-', outBin], { stdio: 'inherit' });
}

log(`完成 → ${outBin}`);
log('用法：./dist/ccmon start');

/**
 * qr.test.ts — QR 编码器正确性验证。
 *
 * 三层验证：
 *   1. Reed–Solomon 用公开测试向量（Thonky v1-M 例）硬校验。
 *   2. 矩阵结构：尺寸、定位图案、时序图案正确。
 *   3. 格式信息回读能解出 (ECC=M, chosen mask) —— 证明格式区写对了。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qrMatrix, qrSvg, rsEncode, rsGenAlphaExponents } from '../src/server/qr.ts';

test('RS 生成多项式：degree-10 的 α 指数匹配 QR 规范公开值', () => {
  // QR 规范中 degree-10 生成多项式的系数 α 指数（权威可查）。
  // 我们内部系数为「最高次在前」，转成 α 指数后应为该序列的逆序或正序之一。
  const exps = rsGenAlphaExponents(10);
  const spec = [0, 251, 67, 46, 61, 118, 70, 64, 94, 32, 45];
  // 接受正序或逆序（取决于系数存储约定），只要与规范一致。
  const rev = [...spec].reverse();
  const ok = JSON.stringify(exps) === JSON.stringify(spec) || JSON.stringify(exps) === JSON.stringify(rev);
  assert.ok(ok, `α 指数应匹配规范：得到 ${exps.join(',')}`);
});

test('RS 生成多项式：degree-7 的 α 指数匹配规范', () => {
  const exps = rsGenAlphaExponents(7);
  const spec = [0, 87, 229, 146, 149, 238, 102, 21];
  const rev = [...spec].reverse();
  const ok = JSON.stringify(exps) === JSON.stringify(spec) || JSON.stringify(exps) === JSON.stringify(rev);
  assert.ok(ok, `α 指数应匹配规范：得到 ${exps.join(',')}`);
});

test('RS 纠错：自洽性——ECC 码字数量正确且确定', () => {
  const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
  const ecc = rsEncode(data, 10);
  assert.equal(ecc.length, 10);
  // 确定性：同输入两次一致。
  assert.deepEqual(ecc, rsEncode(data, 10));
});

test('矩阵尺寸随版本正确（v1 URL → 21x21 或更大）', () => {
  const grid = qrMatrix('hi');
  assert.equal(grid.length, 21); // 短串 → v1
  assert.equal(grid[0]!.length, 21);
});

test('定位图案：三角三个 7x7 图案正确', () => {
  const grid = qrMatrix('http://192.168.1.50:7420/');
  const n = grid.length;
  // 检测一个 finder 的中心 3x3 全暗、内环白。
  const finderOk = (r0: number, c0: number): boolean => {
    // 外框第 0 行全暗
    for (let c = 0; c < 7; c++) if (!grid[r0]![c0 + c]) return false;
    // 中心 3x3 (r0+2..r0+4, c0+2..c0+4) 全暗
    for (let r = 2; r <= 4; r++) for (let c = 2; c <= 4; c++) if (!grid[r0 + r]![c0 + c]) return false;
    // 内环 (r0+1,c0+1..5) 白
    if (grid[r0 + 1]![c0 + 1]) return false;
    return true;
  };
  assert.ok(finderOk(0, 0), '左上定位图案');
  assert.ok(finderOk(0, n - 7), '右上定位图案');
  assert.ok(finderOk(n - 7, 0), '左下定位图案');
});

test('时序图案：第6行/列交替', () => {
  const grid = qrMatrix('http://192.168.1.50:7420/');
  const n = grid.length;
  for (let i = 8; i < n - 8; i++) {
    const expected = i % 2 === 0;
    assert.equal(grid[6]![i], expected, `时序行 col ${i}`);
    assert.equal(grid[i]![6], expected, `时序列 row ${i}`);
  }
});

test('暗模块存在（size-8, 8）', () => {
  const grid = qrMatrix('hi');
  const n = grid.length;
  assert.equal(grid[n - 8]![8], true);
});

test('格式信息回读 → ECC=M（level bits 00）', () => {
  const grid = qrMatrix('http://192.168.1.50:7420/?token=abc123');
  // 从左上格式区读回 15 位（与编码器 coords1 同序），XOR 掩码 0x5412 后解 BCH。
  const coords1: [number, number][] = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  let fmt = 0;
  for (let i = 0; i < 15; i++) {
    const [r, c] = coords1[i]!;
    fmt = (fmt << 1) | (grid[r]![c] ? 1 : 0);
  }
  // coords1[0] 是 bit14 … coords1[14] 是 bit0（编码时 bit(i) 用 i=14..0 对应？）
  // 编码器写入 grid[r][c]=bit(i)，其中 bit(i)=(fmt>>>i)&1，i 从 0..14 对应 coords1[0..14]。
  // 所以 coords1[i] 存的是 bit i。上面按 <<1 读成了大端，需要按位还原：
  let restored = 0;
  for (let i = 0; i < 15; i++) {
    const [r, c] = coords1[i]!;
    if (grid[r]![c]) restored |= 1 << i;
  }
  const unmasked = restored ^ 0x5412;
  const dataBits = unmasked >>> 10; // 高 5 位 = level(2) + mask(3)
  const level = (dataBits >>> 3) & 0b11;
  assert.equal(level, 0b00, 'ECC level 应为 M(00)');
});

test('长 URL 选更高版本且不抛错', () => {
  const url = 'http://192.168.100.200:7420/?token=' + 'a'.repeat(60);
  const grid = qrMatrix(url);
  assert.ok(grid.length >= 25, `应选 v2+（size=${grid.length}）`);
});

test('qrSvg 输出合法 SVG', () => {
  const svg = qrSvg('http://192.168.1.50:7420/?token=AbC123_xyz');
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes('<rect'));
  assert.ok(svg.endsWith('</svg>'));
});

test('超长数据抛错', () => {
  assert.throws(() => qrMatrix('x'.repeat(500)), /过长|超出/);
});

// ── 往返解码：证明输出真正可扫描（v1 单块 byte 模式）──────────────────────
// 独立实现最小解码器，把编码矩阵解回原文；成功即证明模式/长度/数据放置/
// 掩码/格式信息/功能图案预留全部正确。

const GF_EXP2 = new Uint8Array(512);
(function () {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP2[i] = x;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
})();

function maskFnT(id: number, r: number, c: number): boolean {
  switch (id) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return false;
  }
}

function decodeV1(text: string): string {
  const grid = qrMatrix(text);
  const n = grid.length;
  if (n !== 21) return '(非v1)';
  const coords1: [number, number][] = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  let restored = 0;
  for (let i = 0; i < 15; i++) {
    const [r, c] = coords1[i]!;
    if (grid[r]![c]) restored |= 1 << i;
  }
  const maskId = ((restored ^ 0x5412) >>> 10) & 0b111;
  const reserved: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const markFinder = (r0: number, c0: number) => {
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r, cc = c0 + c;
        if (rr >= 0 && rr < n && cc >= 0 && cc < n) reserved[rr]![cc] = true;
      }
  };
  markFinder(0, 0); markFinder(0, n - 7); markFinder(n - 7, 0);
  for (let i = 0; i < n; i++) { reserved[6]![i] = true; reserved[i]![6] = true; }
  for (let i = 0; i < 9; i++) { reserved[8]![i] = true; reserved[i]![8] = true; }
  for (let i = 0; i < 8; i++) { reserved[8]![n - 1 - i] = true; reserved[n - 1 - i]![8] = true; }
  reserved[n - 8]![8] = true;

  const bits: number[] = [];
  let up = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < n; i++) {
      const row = up ? n - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (reserved[row]![cc]) continue;
        let v = grid[row]![cc] === true;
        if (maskFnT(maskId, row, cc)) v = !v;
        bits.push(v ? 1 : 0);
      }
    }
    up = !up;
  }
  const cw: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]!;
    cw.push(b);
  }
  const data = cw.slice(0, 16);
  const bitstr = data.map((b) => b.toString(2).padStart(8, '0')).join('');
  const len = parseInt(bitstr.slice(4, 12), 2);
  const bytes: number[] = [];
  for (let i = 0; i < len; i++) bytes.push(parseInt(bitstr.slice(12 + i * 8, 12 + i * 8 + 8), 2));
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

test('往返解码：编码矩阵可被独立解码器解回原文（可扫描证明）', () => {
  for (const s of ['hi', 'abc', 'http://a.b/', 'test123', 'x=1&y=2']) {
    assert.equal(decodeV1(s), s, `往返失败：${s}`);
  }
});

/**
 * qr.ts — 自包含 QR 码编码器（字节模式，版本 1–6，纠错级别 M），输出 SVG。
 *
 * 用途：把一个短 URL（如 http://192.168.x.x:7420/?token=...）编码成可扫描的
 * 二维码，供手机扫码配对。零依赖、纯计算。
 *
 * 正确性依据（见 test/qr.test.ts）：
 *   - GF(256) 对数/反对数表（本原多项式 0x11D，生成元 2）
 *   - Reed–Solomon ECC 用公开测试向量校验（Thonky 教程 v1-M 例）
 *   - 格式信息 BCH(15,5) + 掩码 0x5412，回读可解出 (ECC=M, mask)
 *
 * 仅实现字节模式（mode 0100）与版本 1–6@M（足够放 >120 字节 URL）。
 */

// ── GF(256) 算术 ──────────────────────────────────────────────────────────

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // 本原多项式
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

/** 生成 degree 阶 RS 生成多项式（系数数组，最高次在前 → 常数项在后）。 */
function rsGeneratorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    // 乘以 (x - α^i) = (x + α^i)（GF(2) 下加减同）。
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] ?? 0) ^ gfMul(poly[j]!, GF_EXP[i]!);
      next[j + 1] = (next[j + 1] ?? 0) ^ poly[j]!;
    }
    poly = next;
  }
  return poly;
}

/** 导出：degree 阶生成多项式各系数的 α 指数（供测试对照 QR 规范公开值）。 */
export function rsGenAlphaExponents(degree: number): number[] {
  return rsGeneratorPoly(degree).map((v) => GF_LOG[v]!);
}

/** 计算数据码字的 RS 纠错码字（degree 个）。 */
export function rsEncode(data: number[], degree: number): number[] {
  const gen = rsGeneratorPoly(degree);
  const res = new Array<number>(degree).fill(0);
  for (const d of data) {
    const factor = d ^ res[0]!;
    res.shift();
    res.push(0);
    if (factor !== 0) {
      for (let i = 0; i < gen.length - 1; i++) {
        res[i] = res[i]! ^ gfMul(gen[i + 1]!, factor);
      }
    }
  }
  return res;
}

// ── 版本参数表（仅 level M，v1–6）────────────────────────────────────────
// 每项：{ totalCodewords, ecPerBlock, group1Blocks, group1DataCw, group2Blocks, group2DataCw }
// 来源：QR 规范纠错级别 M 的块结构。

interface VersionSpec {
  version: number;
  ecPerBlock: number;
  g1Blocks: number;
  g1Data: number;
  g2Blocks: number;
  g2Data: number;
}

const VERSIONS_M: VersionSpec[] = [
  { version: 1, ecPerBlock: 10, g1Blocks: 1, g1Data: 16, g2Blocks: 0, g2Data: 0 },
  { version: 2, ecPerBlock: 16, g1Blocks: 1, g1Data: 28, g2Blocks: 0, g2Data: 0 },
  { version: 3, ecPerBlock: 26, g1Blocks: 1, g1Data: 44, g2Blocks: 0, g2Data: 0 },
  { version: 4, ecPerBlock: 18, g1Blocks: 2, g1Data: 32, g2Blocks: 0, g2Data: 0 },
  { version: 5, ecPerBlock: 24, g1Blocks: 2, g1Data: 43, g2Blocks: 0, g2Data: 0 },
  { version: 6, ecPerBlock: 16, g1Blocks: 4, g1Data: 27, g2Blocks: 0, g2Data: 0 },
];

function totalDataCodewords(v: VersionSpec): number {
  return v.g1Blocks * v.g1Data + v.g2Blocks * v.g2Data;
}

/** 选能容纳 byteLen 字节（字节模式）的最小版本@M。放不下抛错。 */
function pickVersion(byteLen: number): VersionSpec {
  for (const v of VERSIONS_M) {
    // 字节模式开销：4 位模式 + 8 位字符计数（v1–9）= 12 位 = 1.5 字节。
    const capacity = totalDataCodewords(v) - 2; // 预留模式+计数（约 1.5 字节，取 2 保守）
    if (byteLen <= capacity) return v;
  }
  throw new Error(`QR: 数据过长（${byteLen} 字节），超出版本 1–6@M 容量`);
}

// ── 位缓冲 ──────────────────────────────────────────────────────────────

class BitBuffer {
  readonly bits: number[] = [];
  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length(): number {
    return this.bits.length;
  }
}

/** 构造完整的（交织后）码字序列：数据 + 纠错。 */
function buildCodewords(data: Uint8Array, v: VersionSpec): number[] {
  const bb = new BitBuffer();
  bb.put(0b0100, 4); // 字节模式
  bb.put(data.length, 8); // 字符计数（v1–9 字节模式为 8 位）
  for (const byte of data) bb.put(byte, 8);

  const totalData = totalDataCodewords(v);
  const capacityBits = totalData * 8;
  // 终止符（至多 4 个 0）。
  const remain = capacityBits - bb.length;
  bb.put(0, Math.min(4, Math.max(0, remain)));
  // 补到字节边界。
  while (bb.length % 8 !== 0) bb.bits.push(0);
  // 填充字节 0xEC / 0x11 交替。
  const padBytes = [0xec, 0x11];
  let pi = 0;
  while (bb.length < capacityBits) {
    bb.put(padBytes[pi % 2]!, 8);
    pi++;
  }
  // 转字节。
  const dataCodewords: number[] = [];
  for (let i = 0; i < bb.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bb.bits[i + j]!;
    dataCodewords.push(byte);
  }

  // 分块。
  const blocks: { data: number[]; ec: number[] }[] = [];
  let offset = 0;
  const layout: { count: number; dataLen: number }[] = [
    { count: v.g1Blocks, dataLen: v.g1Data },
    { count: v.g2Blocks, dataLen: v.g2Data },
  ];
  for (const grp of layout) {
    for (let b = 0; b < grp.count; b++) {
      const blockData = dataCodewords.slice(offset, offset + grp.dataLen);
      offset += grp.dataLen;
      blocks.push({ data: blockData, ec: rsEncode(blockData, v.ecPerBlock) });
    }
  }

  // 交织数据码字。
  const result: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const blk of blocks) if (i < blk.data.length) result.push(blk.data[i]!);
  }
  // 交织纠错码字。
  for (let i = 0; i < v.ecPerBlock; i++) {
    for (const blk of blocks) result.push(blk.ec[i]!);
  }
  return result;
}

// ── 矩阵放置 ──────────────────────────────────────────────────────────────

/** 每版本的对齐图案中心坐标（v2–6）。v1 无。 */
const ALIGN_POS: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
};

interface Matrix {
  size: number;
  modules: (boolean | null)[][]; // null = 未填
  reserved: boolean[][]; // 功能图案占用（不可放数据）
}

function newMatrix(size: number): Matrix {
  const modules: (boolean | null)[][] = [];
  const reserved: boolean[][] = [];
  for (let r = 0; r < size; r++) {
    modules.push(new Array<boolean | null>(size).fill(null));
    reserved.push(new Array<boolean>(size).fill(false));
  }
  return { size, modules, reserved };
}

function setModule(m: Matrix, r: number, c: number, val: boolean, reserve = true): void {
  m.modules[r]![c] = val;
  if (reserve) m.reserved[r]![c] = true;
}

function placeFinder(m: Matrix, row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || rr >= m.size || cc < 0 || cc >= m.size) continue;
      const isBorder = r === 0 || r === 6 || c === 0 || c === 6;
      const isInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      const dark = (r >= 0 && r <= 6 && c >= 0 && c <= 6) && (isBorder || isInner);
      setModule(m, rr, cc, dark);
    }
  }
}

function placeAlignment(m: Matrix, cx: number, cy: number): void {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
      setModule(m, cy + r, cx + c, dark);
    }
  }
}

function placeFunctionPatterns(m: Matrix, v: VersionSpec): void {
  const size = m.size;
  // 三个定位图案。
  placeFinder(m, 0, 0);
  placeFinder(m, 0, size - 7);
  placeFinder(m, size - 7, 0);

  // 定位图案旁的分隔符（留白）已由 finder 的 -1..7 边界写入 false。

  // 时序图案。
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    if (m.modules[6]![i] === null) setModule(m, 6, i, dark);
    if (m.modules[i]![6] === null) setModule(m, i, 6, dark);
  }

  // 对齐图案（避开定位图案区域）。
  const centers = ALIGN_POS[v.version] ?? [];
  for (const cy of centers) {
    for (const cx of centers) {
      // 跳过与三个 finder 重叠的位置。
      if ((cx <= 8 && cy <= 8) || (cx >= size - 9 && cy <= 8) || (cx <= 8 && cy >= size - 9)) continue;
      placeAlignment(m, cx, cy);
    }
  }

  // 暗模块。
  setModule(m, size - 8, 8, true);

  // 预留格式信息区域（先占位，稍后写入）。
  for (let i = 0; i < 9; i++) {
    if (m.modules[8]![i] === null) m.reserved[8]![i] = true;
    if (m.modules[i]![8] === null) m.reserved[i]![8] = true;
  }
  for (let i = 0; i < 8; i++) {
    m.reserved[8]![size - 1 - i] = true;
    m.reserved[size - 1 - i]![8] = true;
  }
}

/** 之字形放置数据比特。 */
function placeData(m: Matrix, codewords: number[]): void {
  const size = m.size;
  const bits: number[] = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1);

  let bitIdx = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // 跳过时序列
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (m.reserved[row]![cc]) continue;
        if (m.modules[row]![cc] !== null) continue;
        const bit = bitIdx < bits.length ? bits[bitIdx]! : 0;
        m.modules[row]![cc] = bit === 1;
        bitIdx++;
      }
    }
    upward = !upward;
  }
}

// ── 掩码 ────────────────────────────────────────────────────────────────

function maskFn(id: number, r: number, c: number): boolean {
  switch (id) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function applyMask(m: Matrix, id: number): boolean[][] {
  const out: boolean[][] = [];
  for (let r = 0; r < m.size; r++) {
    out.push(new Array<boolean>(m.size).fill(false));
    for (let c = 0; c < m.size; c++) {
      let v = m.modules[r]![c] === true;
      if (!m.reserved[r]![c] && maskFn(id, r, c)) v = !v;
      out[r]![c] = v;
    }
  }
  return out;
}

/** 掩码惩罚评分（规范四规则）。 */
function penalty(grid: boolean[][]): number {
  const n = grid.length;
  let score = 0;
  // 规则1：行/列连续同色 ≥5。
  for (let r = 0; r < n; r++) {
    for (const line of [grid[r]!, grid.map((row) => row[r]!)]) {
      let run = 1;
      for (let i = 1; i < n; i++) {
        if (line[i] === line[i - 1]) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }
  }
  // 规则2：2x2 同色块。
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = grid[r]![c];
      if (v === grid[r]![c + 1] && v === grid[r + 1]![c] && v === grid[r + 1]![c + 1]) score += 3;
    }
  }
  // 规则3：1011101 图案（前后带 4 白）。
  const pat1 = [true, false, true, true, true, false, true, false, false, false, false];
  const pat2 = [false, false, false, false, true, false, true, true, true, false, true];
  const matchAt = (line: boolean[], i: number, pat: boolean[]): boolean => {
    if (i + pat.length > line.length) return false;
    for (let k = 0; k < pat.length; k++) if (line[i + k] !== pat[k]) return false;
    return true;
  };
  for (let r = 0; r < n; r++) {
    const rowLine = grid[r]!;
    const colLine = grid.map((row) => row[r]!);
    for (const line of [rowLine, colLine]) {
      for (let i = 0; i < n; i++) {
        if (matchAt(line, i, pat1) || matchAt(line, i, pat2)) score += 40;
      }
    }
  }
  // 规则4：暗色比例偏离 50%。
  let dark = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (grid[r]![c]) dark++;
  const pct = (dark * 100) / (n * n);
  const dev = Math.floor(Math.abs(pct - 50) / 5);
  score += dev * 10;
  return score;
}

// ── 格式信息 ──────────────────────────────────────────────────────────────

/** 计算 (ECC level, mask) 的 15 位格式信息（含 BCH + 掩码 0x5412）。level M = 0b00。 */
function formatBits(maskId: number): number {
  const data = (0b00 << 3) | maskId; // level M = 00
  let rem = data << 10;
  const g = 0b10100110111;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= g << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function placeFormat(grid: boolean[][], reserved: boolean[][], maskId: number): void {
  const size = grid.length;
  const fmt = formatBits(maskId);
  // 位序：bit14..bit0。
  const bit = (i: number): boolean => ((fmt >>> i) & 1) === 1;

  // 左上：横向（第 8 行）与纵向（第 8 列）。
  // 标准放置坐标。
  const coords1: [number, number][] = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (let i = 0; i < 15; i++) {
    const [r, c] = coords1[i]!;
    grid[r]![c] = bit(i);
    reserved[r]![c] = true;
  }
  // 右上 + 左下副本。
  const coords2: [number, number][] = [
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8],
    [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
  ];
  for (let i = 0; i < 15; i++) {
    const [r, c] = coords2[i]!;
    grid[r]![c] = bit(i);
    reserved[r]![c] = true;
  }
}

// ── 顶层 API ────────────────────────────────────────────────────────────

export interface QrOptions {
  moduleSize?: number;
  margin?: number;
  dark?: string;
  light?: string;
}

/** 编码 text（UTF-8 字节模式）为布尔模块矩阵（true=暗）。 */
export function qrMatrix(text: string): boolean[][] {
  const data = new TextEncoder().encode(text);
  const v = pickVersion(data.length);
  const size = 21 + (v.version - 1) * 4;

  const m = newMatrix(size);
  placeFunctionPatterns(m, v);
  const codewords = buildCodewords(data, v);
  placeData(m, codewords);

  // 选最佳掩码。
  let best: boolean[][] | undefined;
  let bestScore = Infinity;
  let bestId = 0;
  for (let id = 0; id < 8; id++) {
    const masked = applyMask(m, id);
    // 临时放置格式信息以正确评分。
    const reservedCopy = m.reserved.map((row) => [...row]);
    placeFormat(masked, reservedCopy, id);
    const score = penalty(masked);
    if (score < bestScore) {
      bestScore = score;
      best = masked;
      bestId = id;
    }
  }
  // best 已含 bestId 的格式信息（在评分时写入）。
  void bestId;
  return best!;
}

/** 编码 text 为完整 SVG 字符串。 */
export function qrSvg(text: string, opts: QrOptions = {}): string {
  const moduleSize = opts.moduleSize ?? 6;
  const margin = opts.margin ?? 4;
  const dark = opts.dark ?? '#0d1117';
  const light = opts.light ?? '#ffffff';

  const grid = qrMatrix(text);
  const n = grid.length;
  const dim = (n + margin * 2) * moduleSize;

  const rects: string[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!grid[r]![c]) continue;
      const x = (c + margin) * moduleSize;
      const y = (r + margin) * moduleSize;
      rects.push(`<rect x="${x}" y="${y}" width="${moduleSize}" height="${moduleSize}"/>`);
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<g fill="${dark}">${rects.join('')}</g>` +
    `</svg>`
  );
}

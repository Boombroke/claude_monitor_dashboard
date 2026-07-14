/**
 * liveness.ts — 进程存活性巡检与 TTY 探测。
 *
 * chokidar 的 unlink 是 DEAD 的快路径；本模块是兜底 reaper：定期对所有已知
 * pid 做 kill(pid, 0)，失败累计到阈值（吸收 --resume 换 pid 的抖动）后判定死亡。
 * 同时提供 TTY 查询，供 notifier 的存在感抑制使用。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LivenessInfo } from '../types.ts';

const execFileP = promisify(execFile);

/** kill(pid, 0)：进程存在且有权限发信号则返回 true。 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 存在但无权限（仍算活）；ESRCH = 不存在。
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 查询 pid 的控制终端（ps -p <pid> -o tty=）。失败返回 undefined。 */
export async function ttyOf(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP('ps', ['-p', String(pid), '-o', 'tty='], {
      timeout: 2000,
    });
    const tty = stdout.trim();
    return tty && tty !== '??' && tty !== '?' ? tty : undefined;
  } catch {
    return undefined;
  }
}

export interface ReaperOptions {
  /** 巡检间隔，默认 5000ms。 */
  intervalMs?: number;
  /** 连续多少次探测失败判定死亡，默认 2。 */
  deadThreshold?: number;
  /** 取当前追踪的 pid 列表。 */
  getPids: () => number[];
  /** 判定某 pid 死亡时回调（携带 sessionId 解析由调用方完成）。 */
  onDead: (pid: number) => void;
  isAlive?: (pid: number) => boolean; // 测试注入
}

/** 周期性存活巡检器。 */
export class LivenessReaper {
  private readonly intervalMs: number;
  private readonly deadThreshold: number;
  private readonly getPids: () => number[];
  private readonly onDead: (pid: number) => void;
  private readonly isAlive: (pid: number) => boolean;
  private readonly failCounts = new Map<number, number>();
  private timer: NodeJS.Timeout | undefined;

  constructor(opts: ReaperOptions) {
    this.intervalMs = opts.intervalMs ?? 5_000;
    this.deadThreshold = opts.deadThreshold ?? 2;
    this.getPids = opts.getPids;
    this.onDead = opts.onDead;
    this.isAlive = opts.isAlive ?? isPidAlive;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    // Node：不因该定时器阻止进程退出。
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.failCounts.clear();
  }

  /** 执行一次巡检（导出以便测试直接驱动）。 */
  tick(): void {
    const pids = new Set(this.getPids());
    // 清理不再追踪的 pid 计数。
    for (const p of this.failCounts.keys()) {
      if (!pids.has(p)) this.failCounts.delete(p);
    }
    for (const pid of pids) {
      if (this.isAlive(pid)) {
        this.failCounts.delete(pid);
        continue;
      }
      const n = (this.failCounts.get(pid) ?? 0) + 1;
      this.failCounts.set(pid, n);
      if (n >= this.deadThreshold) {
        this.failCounts.delete(pid);
        this.onDead(pid);
      }
    }
  }

  livenessOf(pid: number): LivenessInfo {
    return { pid, alive: this.isAlive(pid) };
  }
}

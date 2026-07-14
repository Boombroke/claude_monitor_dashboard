/**
 * reconciler.ts — 文件 + hook + 存活性 → 单一权威状态。
 *
 * 这是全项目最高风险的逻辑。优先级（从高到低）：
 *
 *   1. 存活性最高：pid 死 / 文件被删 → DEAD（覆盖一切）。
 *   2. 新鲜 hook 事件（在 TTL 内，且比文件 statusUpdatedAt 新）：
 *        permission_prompt / PermissionRequest → NEEDS_APPROVAL
 *        idle_prompt / agent_needs_input       → IDLE_INPUT
 *        Stop / agent_completed                → DONE_WAITING
 *        PreToolUse / PostToolUse              → WORKING
 *      但：若文件此后翻到 busy（新一轮开始），清掉过期的 Stop —— 由"文件更新更晚"
 *      自然体现（文件 statusUpdatedAt > hook.at 时不采纳 hook）。
 *   3. 文件 status 作为无新鲜 hook 时的实时权威：
 *        busy    → WORKING
 *        waiting + waitingFor≈permission → NEEDS_APPROVAL（bypass 会话除外）
 *        waiting（其他） → IDLE_INPUT
 *        idle    → 有未确认完成标记 → DONE_WAITING，否则 IDLE
 *
 * bypassPermissions：关闭 NEEDS_APPROVAL 路径（这类会话永不弹审批）。
 *
 * 时钟：文件用 statusUpdatedAt（epoch ms），hook 用到达时间 at。用它们做 tiebreak。
 */

import type {
  Reconciler,
  ReconcilerInputs,
  SessionState,
  HookPayload,
  PermissionMode,
} from '../types.ts';

export interface ReconcilerOptions {
  /** 新鲜 hook 事件 TTL，默认 30000ms。 */
  hookTtlMs?: number;
  /** 取"现在"，测试可注入。 */
  now?: () => number;
}

function isBypass(mode: PermissionMode | undefined): boolean {
  return mode === 'bypassPermissions';
}

function isPermissionWait(waitingFor: string | undefined): boolean {
  if (!waitingFor) return false;
  return waitingFor.toLowerCase().includes('permission');
}

/** hook 事件映射到候选状态；返回 undefined 表示该事件不驱动状态。 */
function hookToState(payload: HookPayload): SessionState | undefined {
  switch (payload.hook_event_name) {
    case 'Notification': {
      switch (payload.matcher) {
        case 'permission_prompt':
          return 'NEEDS_APPROVAL';
        case 'idle_prompt':
        case 'agent_needs_input':
          return 'IDLE_INPUT';
        case 'agent_completed':
          return 'DONE_WAITING';
        default:
          return undefined; // auth_success 等：不驱动状态
      }
    }
    case 'PermissionRequest':
      return 'NEEDS_APPROVAL';
    case 'Stop':
    case 'SubagentStop':
      return 'DONE_WAITING';
    case 'PreToolUse':
    case 'PostToolUse':
      return 'WORKING';
    default:
      return undefined; // SessionStart/End 等由生命周期另行处理
  }
}

function hookReason(state: SessionState, payload: HookPayload): string {
  switch (state) {
    case 'NEEDS_APPROVAL':
      return payload.tool_name ? `需要审批：${payload.tool_name}` : '需要审批';
    case 'IDLE_INPUT':
      return '等待输入';
    case 'DONE_WAITING':
      return '完成一轮';
    case 'WORKING':
      return payload.tool_name ? `运行：${payload.tool_name}` : '工作中';
    default:
      return '';
  }
}

export class DefaultReconciler implements Reconciler {
  private readonly hookTtlMs: number;
  private readonly now: () => number;

  constructor(opts: ReconcilerOptions = {}) {
    this.hookTtlMs = opts.hookTtlMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  reconcile(inputs: ReconcilerInputs): { state: SessionState; reason?: string } {
    const { file, markers, hook, liveness, previous } = inputs;
    const now = this.now();

    // —— 1. 存活性最高 ——
    if (liveness && liveness.alive === false) {
      return { state: 'DEAD', reason: '进程已退出' };
    }

    const bypass = isBypass(markers?.permissionMode);
    const fileStamp = file?.statusUpdatedAt ?? file?.updatedAt ?? 0;

    // —— 2. 新鲜 hook 事件 ——
    if (hook) {
      const fresh = now - hook.at <= this.hookTtlMs;
      // 文件比 hook 更新（新一轮开始）→ 不采纳过期 hook，转而信任文件。
      const fileNewer = fileStamp > hook.at;
      if (fresh && !fileNewer) {
        let hookState = hookToState(hook.payload);
        // bypass 会话不会有真实审批 —— 若 hook 声称 NEEDS_APPROVAL 且已知 bypass，降级忽略。
        if (hookState === 'NEEDS_APPROVAL' && bypass) hookState = undefined;
        if (hookState) {
          return { state: hookState, reason: hookReason(hookState, hook.payload) };
        }
      }
    }

    // —— 3. 文件 status 权威 ——
    if (file) {
      switch (file.status) {
        case 'busy':
          return { state: 'WORKING', reason: '工作中' };
        case 'waiting': {
          if (isPermissionWait(file.waitingFor) && !bypass) {
            return { state: 'NEEDS_APPROVAL', reason: '需要审批' };
          }
          // bypass 下的 permission wait 理论上不出现；其余 waiting 视为等待输入。
          return { state: 'IDLE_INPUT', reason: '等待输入' };
        }
        case 'idle': {
          if (this.hasUnacknowledgedDone(inputs, previous)) {
            return { state: 'DONE_WAITING', reason: '完成一轮' };
          }
          return { state: 'IDLE' };
        }
      }
    }

    // —— 无文件信号：退回 transcript 标记或上一状态 ——
    if (markers?.turnDoneMarkerAt) {
      return { state: 'DONE_WAITING', reason: '完成一轮' };
    }
    return { state: previous ?? 'IDLE' };
  }

  /**
   * 判断 idle 文件态下是否存在"未被确认的完成标记"，用于区分
   * DONE_WAITING（刚跑完，交回给你）vs 纯 IDLE（早已空闲）。
   *
   * 依据：transcript 出现 turn_duration / away_summary / end_turn，且
   * 该标记时间晚于会话进入上一个 WORKING 的时间。这里用简化判定：
   *   - 有完成标记时间戳 turnDoneMarkerAt，且
   *   - 上一状态是 WORKING（说明刚从干活转出），或末条 stop_reason=end_turn。
   */
  private hasUnacknowledgedDone(inputs: ReconcilerInputs, previous?: SessionState): boolean {
    const m = inputs.markers;
    if (!m) return previous === 'WORKING';
    if (m.lastStopReason === 'tool_use') return false; // 工具在飞，未完成
    if (m.turnDoneMarkerAt) return true;
    if (m.lastStopReason === 'end_turn' && previous === 'WORKING') return true;
    return previous === 'WORKING';
  }
}

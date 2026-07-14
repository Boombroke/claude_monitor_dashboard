/**
 * ccmon — 冻结的类型契约 (FROZEN CONTRACT)
 *
 * 这是所有模块（后端脊柱、并行叶子模块、PWA 前端）共享的单一事实来源。
 * 修改此文件会波及所有并行工作 —— 除非确有必要，不要改动已有字段的语义。
 *
 * 分区：
 *   1. 会话状态与数据模型 (Session)         —— store / reconciler / UI 共用
 *   2. 原始输入信号 (FileSignal / HookSignal) —— watcher / receiver → reconciler
 *   3. Claude Code hook payload             —— hooks/receiver 解析
 *   4. SSE 线路协议 (ServerEvent)            —— server/sse ↔ PWA
 *   5. 通知模型 (Notification)               —— notifier ↔ desktop/ntfy/webpush
 *   6. 模块接口 (SessionStore / Reconciler / Notifier / Watcher)
 *   7. 配置 (Config)
 */

// ─────────────────────────────────────────────────────────────────────────
// 1. 会话状态与数据模型
// ─────────────────────────────────────────────────────────────────────────

/** 会话的派生权威状态。 */
export type SessionState =
  | 'WORKING' // 正在干活（文件 status:busy / PreToolUse / 末条 tool_use）
  | 'NEEDS_APPROVAL' // 卡在权限审批（hook permission_prompt / 文件 waiting:permission）
  | 'IDLE_INPUT' // 等你输入，非审批（hook idle_prompt / 文件 waiting 其他）
  | 'DONE_WAITING' // 一轮结束，交回给你（hook Stop / turn_duration / away_summary / end_turn）
  | 'IDLE' // 空闲，无待处理
  | 'DEAD'; // 进程已退出

/** 需要用户注意的状态集合（UI 置顶、通知触发依据）。 */
export const ATTENTION_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  'NEEDS_APPROVAL',
  'IDLE_INPUT',
  'DONE_WAITING',
]);

/** Claude 会话文件里的原始 status 枚举（实测：busy/idle/waiting；binary 另含更多）。 */
export type FileStatus = 'busy' | 'idle' | 'waiting';

/** 权限模式（transcript permission-mode 记录 / 进程启动参数推断）。 */
export type PermissionMode =
  | 'default'
  | 'plan'
  | 'acceptEdits'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions';

/**
 * 归一化的会话对象 —— 后端维护、推送给 UI 的核心结构。
 * 键 = sessionId（稳定 UUID）。pid 是可变属性（OS 复用 + --resume 换 pid）。
 * UI/通知只应读取此结构，绝不读取原始 transcript 全文。
 */
export interface Session {
  // —— 身份 ——
  sessionId: string; // KEY：稳定 UUID（= transcript 文件名去掉 .jsonl）
  pid: number | null; // 当前存活 pid（介于两次 resume 之间可能为 null）
  pastPids: number[]; // 历史 pid（resume 追踪）
  name: string; // 会话文件里的人类可读名
  nameSource?: string; // "derived" | "auto" | "user"
  cwd: string; // 权威工作目录（从记录读，绝不从 slug 反推）
  project: string; // basename(cwd)，用于分组/展示
  gitBranch?: string; // transcript 记录中的 git 分支（若有）

  // —— 状态 ——
  state: SessionState; // 派生的权威状态
  fileStatus?: FileStatus; // 最近一次文件 status 原值
  waitingFor?: string; // 文件 waitingFor（如 "permission prompt"）
  permissionMode?: PermissionMode; // bypassPermissions 会关闭审批检测路径
  isBackground: boolean; // 是否由 jobs/*/state.json 支撑的后台会话

  // —— 上下文（均截断，低敏） ——
  currentTitle?: string; // ai-title.aiTitle
  lastPrompt?: string; // last-prompt.lastPrompt（截断）
  lastAssistantSummary?: string; // away_summary / 末条文本（截断）
  model?: string; // assistant.message.model

  // —— 时间 ——
  startedAt: number; // epoch ms
  lastActivityAt: number; // max(statusUpdatedAt, updatedAt, 末条记录 ts)
  stateSince: number; // 进入当前 state 的 epoch ms（UI 用它算 timeInState）

  // —— 派生标志 ——
  isAlive: boolean;
  needsAttention: boolean; // ATTENTION_STATES.has(state)
  attentionReason?: string; // 供 UI/通知展示的原因

  // —— 时间线 ——
  events: SessionEvent[]; // 环形缓冲（最近 ~50 条，已脱敏）
}

export type SessionEventKind = 'state' | 'hook' | 'file' | 'notify';

export interface SessionEvent {
  at: number; // epoch ms
  kind: SessionEventKind;
  from?: SessionState;
  to?: SessionState;
  detail?: string; // 已脱敏，绝不含 secret/token/tool_input 原文
}

// ─────────────────────────────────────────────────────────────────────────
// 2. 原始输入信号（watcher / receiver → reconciler）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 来自 ~/.claude/sessions/<pid>.json 的原始快照（sessionsWatcher 产出）。
 * 字段直接映射会话文件；未知字段可透传但不依赖。
 */
export interface SessionFileSnapshot {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  nameSource?: string;
  status: FileStatus;
  waitingFor?: string;
  version?: string;
  kind?: string; // "interactive"
  entrypoint?: string; // "cli"
  startedAt?: number;
  procStart?: string;
  updatedAt?: number;
  statusUpdatedAt?: number;
}

/**
 * transcript tailer 从末尾记录抽取的标记（不含全文）。
 * 全部可选：tailer 只填它当前能确定的字段。
 */
export interface TranscriptMarkers {
  sessionId: string;
  cwd?: string;
  gitBranch?: string;
  currentTitle?: string; // ai-title
  lastPrompt?: string; // last-prompt（截断）
  lastAssistantSummary?: string; // away_summary / 末条 text（截断）
  model?: string;
  permissionMode?: PermissionMode; // 来自 permission-mode 记录
  /** 末条 assistant 记录的 stop_reason（判断 tool_use 在飞 vs end_turn）。 */
  lastStopReason?: 'end_turn' | 'tool_use' | string;
  /** 是否出现了「一轮完成」标记（turn_duration / away_summary / end_turn）。 */
  turnDoneMarkerAt?: number; // epoch ms，最近一次完成标记时间
  lastRecordAt?: number; // 末条记录时间戳 epoch ms
}

/** 后台 job（~/.claude/jobs/<id>/state.json）快照。 */
export interface JobStateSnapshot {
  shortId: string;
  sessionId?: string;
  resumeSessionId?: string;
  cwd?: string;
  name?: string;
  state: string; // "done" | ...
  tempo?: string; // "idle" | ...
  inFlight?: { tasks?: number; queued?: number; kinds?: unknown };
  result?: string; // output.result（截断）
}

/** 存活性探测结果（liveness reaper 产出）。 */
export interface LivenessInfo {
  pid: number;
  alive: boolean;
  tty?: string; // ps -p <pid> -o tty=（存在感抑制用）
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Claude Code hook payload（hooks/receiver 解析 POST /hooks 的 body）
// ─────────────────────────────────────────────────────────────────────────

export type HookEventName =
  | 'Notification'
  | 'Stop'
  | 'SubagentStop'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PermissionRequest'
  | 'SessionStart'
  | 'SessionEnd';

/** Notification hook 的 matcher（通知类型）。 */
export type NotificationMatcher =
  | 'permission_prompt'
  | 'idle_prompt'
  | 'agent_needs_input'
  | 'agent_completed'
  | 'auth_success'
  | string;

/**
 * Claude Code 通过 stdin 传给 hook command 的 JSON（我们让 hook 用 curl 原样 POST 过来）。
 * 只声明我们用到的字段；其余透传忽略。字段名采用 Claude Code 的 snake_case。
 */
export interface HookPayload {
  hook_event_name: HookEventName;
  session_id: string;
  cwd?: string;
  transcript_path?: string;
  permission_mode?: PermissionMode;
  prompt_id?: string;
  /** Notification 事件携带；也可能出现在 settings 的 matcher 位。 */
  matcher?: NotificationMatcher;
  /** Notification 事件的正文。 */
  message?: string;
  /** 工具事件携带。tool_input 敏感 —— 绝不 info 级别记录原文。 */
  tool_name?: string;
  tool_input?: unknown;
  /** Stop / SubagentStop 携带。 */
  last_assistant_message?: string;
  stop_hook_active?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// 4. SSE 线路协议（server/sse ↔ PWA 前端）
// ─────────────────────────────────────────────────────────────────────────

/** 连接建立时的首帧：全量快照。 */
export interface SnapshotEvent {
  type: 'snapshot';
  sessions: Session[];
  serverTime: number; // epoch ms，前端校准时钟
}

/** 单会话增量更新（新增或变更）。 */
export interface SessionUpdateEvent {
  type: 'session.update';
  session: Session;
}

/** 会话移除（DEAD 淡出后彻底移除）。 */
export interface SessionRemoveEvent {
  type: 'session.remove';
  sessionId: string;
}

/** 通知广播（前端可做前台提示 / 声音）。 */
export interface NotificationEvent {
  type: 'notification';
  notification: NotificationView;
}

export type ServerEvent =
  | SnapshotEvent
  | SessionUpdateEvent
  | SessionRemoveEvent
  | NotificationEvent;

// ─────────────────────────────────────────────────────────────────────────
// 5. 通知模型（notifier ↔ desktop / ntfy / webpush）
// ─────────────────────────────────────────────────────────────────────────

/** 通知类别，决定路由（desktop 总是；ntfy 默认只发 needs-you）。 */
export type NotificationClass = 'needs-you' | 'done' | 'info';

export type NotificationPriority = 'low' | 'default' | 'high';

/**
 * notifier 内部构造的规范通知。各渠道适配器（desktop/ntfy/webpush）消费它。
 */
export interface Notification {
  /** 去重键：`${sessionId}:${state}:${bucket}`。 */
  key: string;
  sessionId: string;
  class: NotificationClass;
  priority: NotificationPriority;
  title: string;
  body: string;
  tags: string[]; // ntfy tags，如 ["warning","lock"]
  project: string;
  state: SessionState;
  createdAt: number;
}

/** 推给前端展示的精简通知视图（不含内部去重键之外的敏感信息）。 */
export interface NotificationView {
  sessionId: string;
  class: NotificationClass;
  title: string;
  body: string;
  createdAt: number;
}

/** 单个通知渠道适配器的统一接口。 */
export interface NotificationChannel {
  readonly name: string; // "desktop" | "ntfy" | "webpush"
  /** 是否处理该类别（如 ntfy 默认只处理 needs-you）。 */
  handles(n: Notification): boolean;
  /** 投递。实现应捕获自身错误、绝不抛给 notifier；返回是否成功。 */
  send(n: Notification): Promise<boolean>;
}

// ─────────────────────────────────────────────────────────────────────────
// 6. 模块接口
// ─────────────────────────────────────────────────────────────────────────

/** store 变更事件（server/notifier 订阅）。 */
export type StoreChange =
  | { type: 'upsert'; session: Session; prev?: SessionState }
  | { type: 'remove'; sessionId: string };

export type StoreListener = (change: StoreChange) => void;

/** 会话存储：sessionId 为键，维护 pid 副索引与 resume 重连。 */
export interface SessionStore {
  get(sessionId: string): Session | undefined;
  getByPid(pid: number): Session | undefined;
  all(): Session[];
  /** upsert 并触发监听器；返回更新后的 Session。 */
  upsert(sessionId: string, patch: Partial<Session>): Session;
  /** 应用状态转移（会写入 events 时间线并更新 stateSince/needsAttention）。 */
  setState(sessionId: string, state: SessionState, reason?: string): Session | undefined;
  remove(sessionId: string): void;
  subscribe(listener: StoreListener): () => void;
}

/** reconciler 的输入：两个异步源的最新原始态 + 存活性。 */
export interface ReconcilerInputs {
  file?: SessionFileSnapshot;
  markers?: TranscriptMarkers;
  /** 最近一次 hook 事件（含到达时间，用于 TTL 判定）。 */
  hook?: { payload: HookPayload; at: number };
  liveness?: LivenessInfo;
  /** 上一次派生状态（用于 tiebreak / 完成标记确认）。 */
  previous?: SessionState;
}

/** 调和器：把文件 + hook + 存活性 融合为单一权威状态。 */
export interface Reconciler {
  reconcile(inputs: ReconcilerInputs): { state: SessionState; reason?: string };
}

/** 通知器：接收状态转移，做去重/抑制/限流/合并后扇出到各渠道。 */
export interface Notifier {
  /** 状态转移触发点。notifier 内部决定是否真的发。 */
  onTransition(session: Session, from: SessionState | undefined): void;
}

/** 文件监听器统一生命周期。 */
export interface Watcher {
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────
// 7. 配置
// ─────────────────────────────────────────────────────────────────────────

export interface Config {
  /** ~/.claude 根目录（可被环境变量覆盖以便测试）。 */
  claudeDir: string;
  sessionsDir: string; // <claudeDir>/sessions
  projectsDir: string; // <claudeDir>/projects
  jobsDir: string; // <claudeDir>/jobs
  settingsPath: string; // <claudeDir>/settings.json

  /** HTTP 服务。 */
  host: string; // 默认 127.0.0.1；--lan 时 0.0.0.0
  port: number; // 默认 7420
  lan: boolean; // 是否绑非 loopback（强制 token）
  token?: string; // bearer token（非 loopback 时必需）

  /** 通知。 */
  ntfy?: {
    server: string; // 默认 https://ntfy.sh
    topic: string;
    includeContext: boolean; // 是否在正文含截断的 title/prompt（默认 false）
  };
  desktopNotifications: boolean; // 默认 true
  /** 是否给 DONE_WAITING 也发 ntfy（默认 false，只发 needs-you）。 */
  ntfyOnDone: boolean;

  /** 隐私：全局脱敏（只显 state + project）。 */
  redact: boolean;
  /** 上下文字段截断长度（lastPrompt / summary / title）。 */
  maxContextChars: number; // 默认 120

  /** 行为调参。 */
  hookTtlMs: number; // 新鲜 hook 事件 TTL，默认 30000
  idleGraceMs: number; // 进入 IDLE 前的宽限，默认 60000
  deadGraceMs: number; // 判定 DEAD 前的宽限，默认 3000
  stateDebounceMs: number; // 进入 IDLE/DONE 的去抖，默认 200
  notifyCooldownMs: number; // 同键通知冷却，默认 20000
}

/** 绝不读取/记录的敏感路径片段（watcher denylist 断言用）。 */
export const SECRET_PATH_DENYLIST: readonly string[] = [
  '/ide/', // ~/.claude/ide/<port>.lock 含 authToken
  '/daemon/control.key', // 32-byte 密钥
];

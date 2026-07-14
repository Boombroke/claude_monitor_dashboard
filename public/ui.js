// ccmon PWA — 渲染层（纯函数式，零依赖）。
// app.js 负责状态与 SSE；本模块只负责把状态渲染成 DOM。

export const STATE_LABEL = {
  WORKING: '工作中',
  NEEDS_APPROVAL: '🔐 需要审批',
  IDLE_INPUT: '💬 等待输入',
  DONE_WAITING: '✅ 完成',
  IDLE: '空闲',
  DEAD: '已结束',
};

// 时间线事件类型的中文标签。
const KIND_LABEL = {
  state: '状态',
  hook: '钩子',
  file: '文件',
  notify: '通知',
};

// 需要用户注意的状态（置顶 + “等待 Xm” 前缀）。
const ATTENTION = ['NEEDS_APPROVAL', 'IDLE_INPUT', 'DONE_WAITING'];

// UI 分区顺序：需要你的置顶。
export const SECTIONS = [
  { key: 'attention', title: '需要你', states: ['NEEDS_APPROVAL', 'IDLE_INPUT', 'DONE_WAITING'] },
  { key: 'working', title: '工作中', states: ['WORKING'] },
  { key: 'idle', title: '空闲', states: ['IDLE'] },
  { key: 'dead', title: '已结束', states: ['DEAD'] },
];

// 过滤 / 展示顺序用的全部状态。
export const ALL_STATES = [
  'NEEDS_APPROVAL',
  'IDLE_INPUT',
  'DONE_WAITING',
  'WORKING',
  'IDLE',
  'DEAD',
];

export function fmtDuration(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

/** 1234→"1K"，1_000_000→"1M"，1_500_000→"1.5M"。 */
export function fmtTokens(n) {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return Math.round(n / 1000) + 'K';
  const m = n / 1_000_000;
  return (Number.isInteger(m) ? String(m) : m.toFixed(1)) + 'M';
}

/** epoch ms → HH:MM:SS（本地时区）。 */
export function fmtClock(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** UUID → 合法的 view-transition-name（只留字母数字）。 */
export function cssId(id) {
  return String(id).replace(/[^a-zA-Z0-9]/g, '');
}

/**
 * 每秒就地更新各卡片的时长文本（不重建 DOM、不触发 View Transition）。
 * 只改 .dur 的 textContent，性能开销极小。
 */
export function tickDurations(root, ctx) {
  const now = Date.now() + ctx.serverSkewMs;
  for (const cardEl of root.querySelectorAll('.card[data-sid]')) {
    const s = ctx.sessions.get(cardEl.dataset.sid);
    if (!s) continue;
    const durEl = cardEl.querySelector('.dur');
    if (!durEl) continue;
    const dur = fmtDuration(now - (s.stateSince || now));
    durEl.textContent = durEl.dataset.waiting === '1' ? `等待 ${dur}` : dur;
  }
}

function stateName(st) {
  return STATE_LABEL[st] || st || '?';
}

/** 渲染单会话的展开式时间线。 */
function timelineEl(session, ctx) {
  const box = el('div', 'timeline');
  const entry = ctx.timelines.get(session.sessionId);

  if (!entry || entry.status === 'loading') {
    box.append(el('div', 'tl-msg', '加载时间线…'));
    return box;
  }
  if (entry.status === 'error') {
    const err = el('div', 'tl-msg tl-err', '加载失败，点击重试');
    err.addEventListener('click', (e) => {
      e.stopPropagation();
      ctx.onRefetch(session.sessionId);
    });
    box.append(err);
    return box;
  }
  const events = entry.events || [];
  if (events.length === 0) {
    box.append(el('div', 'tl-msg', '暂无事件'));
    return box;
  }

  const list = el('div', 'tl-list');
  // 最新在上。
  for (const ev of [...events].reverse()) {
    const row = el('div', 'tl-item');
    row.append(el('span', 'tl-time', fmtClock(ev.at)));
    row.append(el('span', `tl-kind k-${ev.kind}`, KIND_LABEL[ev.kind] || ev.kind));
    let desc = '';
    if (ev.from || ev.to) desc = `${stateName(ev.from)} → ${stateName(ev.to)}`;
    if (ev.detail) desc = desc ? `${desc} · ${ev.detail}` : ev.detail;
    row.append(el('span', 'tl-desc', desc));
    list.append(row);
  }
  box.append(list);
  return box;
}

function card(session, ctx, now) {
  const isOpen = ctx.expanded.has(session.sessionId);
  const c = el('div', `card s-${session.state}${isOpen ? ' expanded' : ''}`);
  c.dataset.sid = session.sessionId;
  // View Transitions：给每张卡片唯一名字，重排时自动补间位移。
  c.style.viewTransitionName = 'card-' + cssId(session.sessionId);

  const head = el('div', 'card-head');
  head.append(el('div', 'name', session.name || session.sessionId.slice(0, 8)));
  head.append(el('div', `badge s-${session.state}`, stateName(session.state)));
  head.append(el('div', 'caret', '▸'));

  // 完整工作目录（可点击复制路径）。
  const cwd = session.cwd || session.project || '';
  const dir = el('div', 'cwd', cwd);
  dir.title = cwd;
  head.append(dir);

  if (session.currentTitle || session.lastPrompt) {
    head.append(el('div', 'prompt', session.currentTitle || session.lastPrompt));
  }

  const waiting = ATTENTION.includes(session.state);
  const dur = fmtDuration(now - (session.stateSince || now));
  const meta = el('div', 'meta');
  // 时长 span 单独标记，供每秒 tick 就地更新（不重建 DOM）。
  const durSpan = el('span', 'dur', waiting ? `等待 ${dur}` : dur);
  durSpan.dataset.waiting = waiting ? '1' : '0';
  meta.append(durSpan);
  if (session.model) meta.append(el('span', '', session.model));
  if (session.gitBranch) meta.append(el('span', '', `⎇ ${session.gitBranch}`));
  if (session.pid) meta.append(el('span', '', `pid ${session.pid}`));
  head.append(meta);

  // 上下文用量条（收起态也可见，监控核心）。
  const ctxBar = ctxEl(session);
  if (ctxBar) head.append(ctxBar);

  head.addEventListener('click', () => ctx.onToggle(session.sessionId));
  c.append(head);

  // 「进入」按钮：聚焦该会话的终端（不展开卡片，故 stopPropagation）。
  // 仅对存活会话显示（DEAD 无意义）。
  if (session.state !== 'DEAD' && ctx.onFocus) {
    const actions = el('div', 'card-actions');
    const enter = el('button', 'btn enter-btn', '⇥ 进入会话');
    enter.type = 'button';
    enter.addEventListener('click', (e) => {
      e.stopPropagation();
      ctx.onFocus(session.sessionId, enter);
    });
    actions.append(enter);
    c.append(actions);
  }

  if (isOpen) {
    c.append(repliesEl(session)); // 「最近回复」——AI 到哪一步了（主角）
    // 状态时间线：默认折叠，避免一大把时间戳喧宾夺主。
    const details = el('details', 'tl-details');
    // 记住每个会话时间线的展开状态，重渲染后保持。
    if (ctx.timelineOpen && ctx.timelineOpen.has(session.sessionId)) details.open = true;
    const summary = el('summary', 'tl-summary', '详细时间线');
    details.append(summary);
    details.addEventListener('toggle', (e) => {
      e.stopPropagation();
      if (!ctx.timelineOpen) return;
      if (details.open) ctx.timelineOpen.add(session.sessionId);
      else ctx.timelineOpen.delete(session.sessionId);
    });
    // summary 点击不要冒泡到卡片头（避免折叠整张卡）。
    summary.addEventListener('click', (e) => e.stopPropagation());
    details.append(timelineEl(session, ctx));
    c.append(details);
  }
  return c;
}

/** 上下文用量条：读 contextTokens/contextWindow，百分比/剩余在视图派生。 */
function ctxEl(session) {
  const used = session.contextTokens;
  const win = session.contextWindow;
  if (used == null || !win) return null; // 老会话/无 usage → 不渲染，优雅降级
  const ratio = Math.min(1, used / win); // 条宽钳到 100%
  const pct = Math.round((used / win) * 100);
  const lvl = pct >= 90 ? 'lvl-danger' : pct >= 70 ? 'lvl-warn' : 'lvl-ok';
  const remain = Math.max(0, win - used);

  const box = el('div', `ctx ${lvl}`);
  box.title = `上下文 ${fmtTokens(used)} / ${fmtTokens(win)}（${pct}%）· 剩余 ${fmtTokens(remain)}`;

  const track = el('div', 'ctx-track');
  const fill = el('div', 'ctx-fill');
  fill.style.transform = `scaleX(${ratio})`; // 只动 transform → SSE 更新丝滑补间
  track.append(fill);

  const label = el('div', 'ctx-label');
  label.append(el('span', 'ctx-used', `${fmtTokens(used)} / ${fmtTokens(win)}`));
  label.append(el('span', 'ctx-pct', `${pct}%`));
  box.append(track, label);
  return box;
}

/** 渲染「最近回复」块：最近 N 条助手消息（新→旧），看 AI 进行到哪一步。 */
function repliesEl(session) {
  const replies = session.recentReplies || [];
  const box = el('div', 'replies');
  const title = el('div', 'replies-title', '最近回复');
  box.append(title);
  if (replies.length === 0) {
    box.append(el('div', 'tl-msg', '暂无回复记录'));
    return box;
  }
  const list = el('div', 'replies-list');
  // 最新在上。
  for (const text of [...replies].reverse()) {
    list.append(el('div', 'reply-item', text));
  }
  box.append(list);
  return box;
}

/**
 * 把当前会话集合渲染进 root（#app）。
 * ctx = { sessions:Map, serverSkewMs, filters:{states:Set, search}, expanded:Set,
 *         timelines:Map, onToggle(id), onRefetch(id) }
 */
export function renderSessions(root, ctx) {
  root.textContent = '';
  const all = [...ctx.sessions.values()];
  if (all.length === 0) {
    root.append(el('div', 'empty', '暂无 Claude 会话'));
    return;
  }

  const q = ctx.filters.search.trim().toLowerCase();
  const filtered = all.filter((s) => {
    if (!ctx.filters.states.has(s.state)) return false;
    if (q) {
      const hay = `${s.name || ''} ${s.project || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    root.append(el('div', 'empty', '没有匹配的会话'));
    return;
  }

  const now = Date.now() + ctx.serverSkewMs;
  for (const section of SECTIONS) {
    const items = filtered
      .filter((s) => section.states.includes(s.state))
      .sort((a, b) => (a.stateSince || 0) - (b.stateSince || 0)); // 等最久的在前
    if (items.length === 0) continue;
    const wrap = el('section', section.key === 'attention' ? 'attention' : '');
    const title = el('div', 'section-title', section.title);
    title.append(el('span', 'count', String(items.length)));
    wrap.append(title);
    for (const s of items) wrap.append(card(s, ctx, now));
    root.append(wrap);
  }
}

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

  const head = el('div', 'card-head');
  head.append(el('div', 'name', session.name || session.sessionId.slice(0, 8)));
  head.append(el('div', `badge s-${session.state}`, stateName(session.state)));
  head.append(el('div', 'caret', '▸'));
  head.append(el('div', 'project', session.project || session.cwd || ''));

  if (session.currentTitle || session.lastPrompt) {
    head.append(el('div', 'prompt', session.currentTitle || session.lastPrompt));
  }

  const waiting = ATTENTION.includes(session.state);
  const dur = fmtDuration(now - (session.stateSince || now));
  const bits = [waiting ? `等待 ${dur}` : dur];
  if (session.model) bits.push(session.model);
  if (session.gitBranch) bits.push(`⎇ ${session.gitBranch}`);
  if (session.pid) bits.push(`pid ${session.pid}`);
  head.append(el('div', 'meta', bits.join(' · ')));

  head.addEventListener('click', () => ctx.onToggle(session.sessionId));
  c.append(head);

  if (isOpen) c.append(timelineEl(session, ctx));
  return c;
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
    wrap.append(el('div', 'section-title', `${section.title} · ${items.length}`));
    for (const s of items) wrap.append(card(s, ctx, now));
    root.append(wrap);
  }
}

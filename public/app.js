// ccmon PWA — M1 极简版（零依赖 vanilla JS，消费 SSE）。
// pwa 叶子模块后续可升级为 Preact + 时间线 + 过滤 + Web Push。

const STATE_LABEL = {
  WORKING: '工作中',
  NEEDS_APPROVAL: '🔐 需要审批',
  IDLE_INPUT: '💬 等待输入',
  DONE_WAITING: '✅ 完成',
  IDLE: '空闲',
  DEAD: '已结束',
};

// UI 分区顺序：需要你的置顶。
const SECTIONS = [
  { key: 'attention', title: '需要你', states: ['NEEDS_APPROVAL', 'IDLE_INPUT', 'DONE_WAITING'] },
  { key: 'working', title: '工作中', states: ['WORKING'] },
  { key: 'idle', title: '空闲', states: ['IDLE'] },
  { key: 'dead', title: '已结束', states: ['DEAD'] },
];

/** sessionId → session */
const sessions = new Map();
let serverSkewMs = 0;

const app = document.getElementById('app');
const conn = document.getElementById('conn');

function fmtDuration(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function card(s) {
  const c = el('div', `card s-${s.state}`);

  const name = el('div', 'name', s.name || s.sessionId.slice(0, 8));
  const badge = el('div', `badge s-${s.state}`, STATE_LABEL[s.state] || s.state);
  const project = el('div', 'project', s.project || s.cwd || '');

  const now = Date.now() + serverSkewMs;
  const bits = [fmtDuration(now - (s.stateSince || now))];
  if (s.model) bits.push(s.model);
  if (s.gitBranch) bits.push(`⎇ ${s.gitBranch}`);
  if (s.pid) bits.push(`pid ${s.pid}`);
  const meta = el('div', 'meta', bits.join(' · '));

  c.append(name, badge, project);
  if (s.currentTitle || s.lastPrompt) {
    c.append(el('div', 'prompt', s.currentTitle || s.lastPrompt));
  }
  c.append(meta);
  return c;
}

function render() {
  app.textContent = '';
  const list = [...sessions.values()];
  if (list.length === 0) {
    app.append(el('div', 'empty', '暂无 Claude 会话'));
    return;
  }
  for (const section of SECTIONS) {
    const items = list
      .filter((s) => section.states.includes(s.state))
      .sort((a, b) => (a.stateSince || 0) - (b.stateSince || 0)); // 等最久的在前
    if (items.length === 0) continue;
    const wrap = el('section', section.key === 'attention' ? 'attention' : '');
    wrap.append(el('div', 'section-title', `${section.title} · ${items.length}`));
    for (const s of items) wrap.append(card(s));
    app.append(wrap);
  }
}

function connect() {
  const token = new URLSearchParams(location.search).get('token');
  const url = token ? `/events?token=${encodeURIComponent(token)}` : '/events';
  const es = new EventSource(url);

  es.onopen = () => {
    conn.textContent = '● 已连接';
    conn.className = 'conn ok';
  };
  es.onerror = () => {
    conn.textContent = '○ 重连中…';
    conn.className = 'conn err';
  };
  es.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'snapshot':
        sessions.clear();
        for (const s of msg.sessions) sessions.set(s.sessionId, s);
        if (msg.serverTime) serverSkewMs = msg.serverTime - Date.now();
        render();
        break;
      case 'session.update':
        sessions.set(msg.session.sessionId, msg.session);
        render();
        break;
      case 'session.remove':
        sessions.delete(msg.sessionId);
        render();
        break;
      case 'notification':
        maybeNotify(msg.notification);
        break;
    }
  };
}

function maybeNotify(n) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(n.title, { body: n.body });
  } catch {
    /* ignore */
  }
}

// 每秒刷新 timeInState 显示。
setInterval(render, 1000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

connect();

// ccmon PWA — M3 版（零依赖 vanilla JS ES module，消费 SSE）。
// 状态 + SSE + 过滤 + 时间线拉取 + 通知 + 安装提示；渲染委托给 ui.js。

import { ALL_STATES, STATE_LABEL, renderSessions, el } from './ui.js';

// —— 全局状态 ——
/** sessionId → Session */
const sessions = new Map();
let serverSkewMs = 0;

/** 展开的会话（显示时间线）。 */
const expanded = new Set();
/** sessionId → { status:'loading'|'ok'|'error', events?:SessionEvent[] } */
const timelines = new Map();

const filters = {
  states: new Set(ALL_STATES), // 默认全开
  search: '',
};

let muted = localStorage.getItem('ccmon.muted') === '1';
let deferredInstall = null;

// —— DOM ——
const app = document.getElementById('app');
const conn = document.getElementById('conn');
const btnNotify = document.getElementById('btn-notify');
const btnInstall = document.getElementById('btn-install');
const muteToggle = document.getElementById('mute-toggle');
const chipBar = document.getElementById('state-chips');
const searchBox = document.getElementById('search');

// —— token 透传：SSE + /api 一致 ——
const TOKEN = new URLSearchParams(location.search).get('token');
function withToken(path) {
  if (!TOKEN) return path;
  return path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN);
}

// —— 渲染 ——
function render() {
  renderSessions(app, {
    sessions,
    serverSkewMs,
    filters,
    expanded,
    timelines,
    onToggle: toggleSession,
    onRefetch: fetchTimeline,
  });
}

// —— 时间线拉取（优先 /history，回退 /timeline）——
async function fetchTimeline(id) {
  timelines.set(id, { status: 'loading' });
  render();
  const events = await loadEvents(id);
  if (events) {
    timelines.set(id, { status: 'ok', events });
  } else {
    timelines.set(id, { status: 'error' });
  }
  render();
}

async function loadEvents(id) {
  // 可选：若后端提供 /history 则优先用（feature-detect），否则回退 /timeline。
  for (const suffix of ['history', 'timeline']) {
    try {
      const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(id)}/${suffix}`));
      if (!res.ok) {
        if (res.status === 404 && suffix === 'history') continue; // 尝试回退
        return null;
      }
      const data = await res.json();
      // 两种端点都约定返回 { sessionId, events }。
      if (data && Array.isArray(data.events)) return data.events;
      return [];
    } catch {
      // history 出错也回退 timeline；timeline 出错才算失败。
      if (suffix === 'history') continue;
      return null;
    }
  }
  return null;
}

function toggleSession(id) {
  if (expanded.has(id)) {
    expanded.delete(id);
    render();
    return;
  }
  expanded.add(id);
  // 已有缓存则直接展示，否则拉取。
  const cached = timelines.get(id);
  if (!cached || cached.status === 'error') {
    fetchTimeline(id);
  } else {
    render();
  }
}

// —— SSE ——
function connect() {
  const es = new EventSource(withToken('/events'));

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
        pruneStale();
        render();
        break;
      case 'session.update':
        sessions.set(msg.session.sessionId, msg.session);
        // 若该会话正展开且时间线已缓存，用推送里的 events 顺带刷新（若有）。
        if (expanded.has(msg.session.sessionId) && Array.isArray(msg.session.events)) {
          timelines.set(msg.session.sessionId, { status: 'ok', events: msg.session.events });
        }
        render();
        break;
      case 'session.remove':
        sessions.delete(msg.sessionId);
        expanded.delete(msg.sessionId);
        timelines.delete(msg.sessionId);
        render();
        break;
      case 'notification':
        maybeNotify(msg.notification);
        break;
    }
  };
}

/** 移除对已不存在会话的展开/缓存引用。 */
function pruneStale() {
  for (const id of [...expanded]) if (!sessions.has(id)) expanded.delete(id);
  for (const id of [...timelines.keys()]) if (!sessions.has(id)) timelines.delete(id);
}

// —— 通知 ——
function maybeNotify(n) {
  if (muted) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(n.title, { body: n.body, tag: n.sessionId });
  } catch {
    /* ignore */
  }
}

// —— header 控件 ——
function refreshNotifyBtn() {
  if (!btnNotify) return;
  const supported = 'Notification' in window;
  const granted = supported && Notification.permission === 'granted';
  btnNotify.hidden = !supported || granted;
}

function initNotifyButton() {
  refreshNotifyBtn();
  if (btnNotify) {
    btnNotify.addEventListener('click', async () => {
      if (!('Notification' in window)) return;
      try {
        await Notification.requestPermission();
      } catch {
        /* ignore */
      }
      refreshNotifyBtn();
    });
  }
}

function initMuteToggle() {
  if (!muteToggle) return;
  muteToggle.checked = muted;
  muteToggle.addEventListener('change', () => {
    muted = muteToggle.checked;
    localStorage.setItem('ccmon.muted', muted ? '1' : '0');
  });
}

// —— 状态过滤 chips ——
function initChips() {
  if (!chipBar) return;
  for (const st of ALL_STATES) {
    const chip = el('button', `chip active s-${st}`, STATE_LABEL[st] || st);
    chip.type = 'button';
    chip.dataset.state = st;
    chip.addEventListener('click', () => {
      if (filters.states.has(st)) {
        filters.states.delete(st);
        chip.classList.remove('active');
      } else {
        filters.states.add(st);
        chip.classList.add('active');
      }
      render();
    });
    chipBar.append(chip);
  }
}

function initSearch() {
  if (!searchBox) return;
  searchBox.addEventListener('input', () => {
    filters.search = searchBox.value;
    render();
  });
}

// —— 安装提示 ——
function initInstall() {
  if (!btnInstall) return;
  btnInstall.hidden = true;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    btnInstall.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    btnInstall.hidden = true;
  });
  btnInstall.addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    try {
      await deferredInstall.userChoice;
    } catch {
      /* ignore */
    }
    deferredInstall = null;
    btnInstall.hidden = true;
  });
}

// —— 启动 ——
initNotifyButton();
initMuteToggle();
initChips();
initSearch();
initInstall();

// 每秒刷新 timeInState / 等待时长显示。
setInterval(render, 1000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

connect();

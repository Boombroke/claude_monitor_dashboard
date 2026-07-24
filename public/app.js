// ccmon PWA — M3 版（零依赖 vanilla JS ES module，消费 SSE）。
// 状态 + SSE + 过滤 + 时间线拉取 + 通知 + 安装提示；渲染委托给 ui.js。

import { ALL_STATES, STATE_LABEL, DONE_BURST_MS, renderSessions, tickDurations, el } from './ui.js';

// —— 全局状态 ——
/** key（`${agent}:${sessionId}`）→ Session */
const sessions = new Map();
let serverSkewMs = 0;

/** 展开的会话（显示详情）。 */
const expanded = new Set();
/** 展开了「详细时间线」小节的会话（保持折叠状态）。 */
const timelineOpen = new Set();
/**
 * 折叠覆盖：key → boolean（true=用户强制展开，false=用户强制折叠）。
 * 未记录的会话按 tier 默认：紫=默认展开，其余=默认折叠。
 */
const foldOverride = new Map();

/** 该会话默认是否展开（紫色最高优先级默认完整展开，其余默认折叠）。 */
function defaultOpen(s) {
  return s ? s.priority === 'purple' : false;
}
/** 该会话当前是否展开：用户覆盖优先，否则按 tier 默认。 */
function isOpen(s) {
  if (!s) return false;
  if (foldOverride.has(s.key)) return foldOverride.get(s.key);
  return defaultOpen(s);
}
/** sessionId → { status:'loading'|'ok'|'error', events?:SessionEvent[] } */
const timelines = new Map();

/** 正在播放「刚完成」爆发特效的会话（进入 DONE_WAITING 后的短窗口内）。 */
const justDone = new Set();
/** sessionId → 爆发撤除定时器句柄，用于去重/清理。 */
const justDoneTimers = new Map();

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
function doRender() {
  renderSessions(app, {
    sessions,
    serverSkewMs,
    filters,
    expanded,
    timelines,
    timelineOpen,
    justDone,
    isOpen,
    onToggle: toggleSession,
    onRefetch: fetchTimeline,
    onFocus: focusSession,
    onSetPriority: setPriority,
  });
}

// 结构签名：可见会话的 id + 状态 + 分区归属。只有它变了才值得用 View Transition
// 做重排/增删动画；纯内容更新（recentReplies 增长、上下文条移动）直接即时渲染，
// 避免过渡期间的旧快照"冻结"住展开卡片的实时内容。
function structuralSig() {
  const ids = [...sessions.keys()].sort();
  return ids.map((id) => `${id}:${sessions.get(id).state}:${sessions.get(id).priority || ''}`).join('|');
}
let lastSig = '';
let vtPending = false;
let vtDirty = false;

// renderSessions() 每次都 `#app.textContent=''` 整树重建，DOM 高度会瞬间塌成 0，
// 整页（window）的滚动位置随之被顶到顶部。故渲染前后夹一层滚动位置的保存/恢复：
// 记下 scrollY，渲染完立即还原，肉眼无跳动。SSE 后台重渲染时用户滚动位置得以保持。
function renderKeepingScroll(fn) {
  const y = window.scrollY;
  fn();
  // 内容一般等高，直接还原即可；用 'instant' 避免与 View Transition 的位移动画打架。
  if (window.scrollY !== y) window.scrollTo({ top: y, left: 0, behavior: 'instant' });
}

function render(force = false) {
  const sig = structuralSig();
  const structural = force || sig !== lastSig;
  lastSig = sig;

  // 非结构性变化（只是内容更新）→ 直接渲染，实时、不冻结。
  if (!structural || typeof document.startViewTransition !== 'function') {
    renderKeepingScroll(doRender);
    return;
  }
  // 结构性变化 → View Transition 丝滑重排。
  if (vtPending) {
    vtDirty = true;
    return;
  }
  vtPending = true;
  const vt = document.startViewTransition(() => renderKeepingScroll(doRender));
  vt.finished.finally(() => {
    vtPending = false;
    if (vtDirty) {
      vtDirty = false;
      render(true);
    }
  });
}

// —— 优先级：POST /priority，乐观更新本地会话后重排（服务端会再广播权威值） ——
async function setPriority(id, level) {
  const s = sessions.get(id);
  if (s) {
    if (level) s.priority = level;
    else delete s.priority;
    render(true); // 乐观即时重排（结构性变化）
  }
  try {
    await fetch(withToken(`/api/sessions/${encodeURIComponent(id)}/priority`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level }),
    });
  } catch {
    /* 失败也无妨：服务端权威值会随下一次 SSE 覆盖回来 */
  }
}

// —— 进入会话：POST /focus，把该会话的终端切到前台 ——
async function focusSession(id, btn) {
  const prev = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '进入中…';
  }
  try {
    const res = await fetch(withToken(`/api/sessions/${encodeURIComponent(id)}/focus`), { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (btn) {
      if (res.ok && data.ok) {
        const label = {
          'opened-new': '已开新终端',
          'activated-editor': '已切到编辑器',
          'focused-tab': '已切换 ✓',
        };
        btn.textContent = label[data.method] || '已切换 ✓';
      } else {
        btn.textContent = '未找到终端';
      }
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = prev;
      }, 1500);
    }
  } catch {
    if (btn) {
      btn.textContent = '失败';
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = prev;
      }, 1500);
    }
  }
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
  const s = sessions.get(id);
  const nowOpen = isOpen(s);
  // 记录显式覆盖：翻转当前（含 tier 默认）状态。
  foldOverride.set(id, !nowOpen);
  if (nowOpen) {
    render();
    return;
  }
  // 展开：已有缓存则直接展示，否则拉取时间线。
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
        for (const s of msg.sessions) sessions.set(s.key, s);
        if (msg.serverTime) serverSkewMs = msg.serverTime - Date.now();
        pruneStale();
        render();
        restoreScrollOnce(); // 首帧快照渲染后，恢复 F5 前的滚动位置（仅一次）
        break;
      case 'session.update': {
        const id = msg.session.key;
        const prev = sessions.get(id);
        sessions.set(id, msg.session);
        // 只有「真实转换进入完成态」才触发爆发：旧态存在且非 DONE_WAITING、
        // 新态是 DONE_WAITING。快照重放 / 首次出现（prev 为空）都不炸——
        // 避免把早已完成的会话也闪一遍。
        if (prev && prev.state !== 'DONE_WAITING' && msg.session.state === 'DONE_WAITING') {
          triggerDoneBurst(id);
        }
        // 若该会话正展开且时间线已缓存，用推送里的 events 顺带刷新（若有）。
        if (isOpen(sessions.get(id)) && Array.isArray(msg.session.events)) {
          timelines.set(id, { status: 'ok', events: msg.session.events });
        }
        render();
        break;
      }
      case 'session.remove':
        sessions.delete(msg.key);
        expanded.delete(msg.key);
        foldOverride.delete(msg.key);
        timelines.delete(msg.key);
        render();
        break;
      case 'notification':
        maybeNotify(msg.notification);
        break;
    }
  };
}

/**
 * 触发某会话的「刚完成」爆发特效：加入 justDone 集合，DONE_BURST_MS 后移除。
 * 重复触发（罕见）会重置计时，特效重新计满整窗口。
 */
function triggerDoneBurst(id) {
  const existing = justDoneTimers.get(id);
  if (existing) clearTimeout(existing);
  justDone.add(id);
  const timer = setTimeout(() => {
    justDone.delete(id);
    justDoneTimers.delete(id);
    // 爆发结束：重渲染撤下 .just-done，转入持续柔和呼吸（纯 CSS）。
    render(true);
  }, DONE_BURST_MS);
  justDoneTimers.set(id, timer);
}

/** 移除对已不存在会话的展开/缓存引用。 */
function pruneStale() {
  for (const id of [...expanded]) if (!sessions.has(id)) expanded.delete(id);
  for (const id of [...foldOverride.keys()]) if (!sessions.has(id)) foldOverride.delete(id);
  for (const id of [...timelines.keys()]) if (!sessions.has(id)) timelines.delete(id);
  // 会话消失时清理其爆发计时器，避免悬挂定时器对已删卡片调 render。
  for (const id of [...justDoneTimers.keys()]) {
    if (!sessions.has(id)) {
      clearTimeout(justDoneTimers.get(id));
      justDoneTimers.delete(id);
      justDone.delete(id);
    }
  }
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

// —— 滚动位置跨刷新保持（F5 / Ctrl-R） ——
// 浏览器默认的滚动恢复发生在 DOM 就绪时，但会话列表要等 SSE 快照异步到达才渲染，
// 那一刻 #app 还是空的、页面没高度，恢复必然落空停在顶部。故改为手动恢复：
// 持续把 scrollY 存进 sessionStorage，首帧快照渲染出内容后再还原一次。
const SCROLL_KEY = 'ccmon.scrollY';
let scrollRestored = false;
if ('scrollRestoration' in history) {
  try {
    history.scrollRestoration = 'manual'; // 关掉浏览器自带恢复，避免与手动恢复打架
  } catch {
    /* ignore */
  }
}
// 记录滚动位置：滚动时（下一帧合并写入）+ 页面隐藏时兜底。
let scrollSaveScheduled = false;
function saveScrollSoon() {
  if (scrollSaveScheduled) return;
  scrollSaveScheduled = true;
  requestAnimationFrame(() => {
    scrollSaveScheduled = false;
    try {
      sessionStorage.setItem(SCROLL_KEY, String(window.scrollY));
    } catch {
      /* 隐私模式等禁用 storage：放弃保持，不致命 */
    }
  });
}
window.addEventListener('scroll', saveScrollSoon, { passive: true });
window.addEventListener('pagehide', () => {
  try {
    sessionStorage.setItem(SCROLL_KEY, String(window.scrollY));
  } catch {
    /* ignore */
  }
});
// 首帧快照渲染后恢复一次。内容随卡片渲染逐步变高，故用 rAF 重试直到页面够高（或超时）。
function restoreScrollOnce() {
  if (scrollRestored) return;
  scrollRestored = true;
  let target = 0;
  try {
    target = Number(sessionStorage.getItem(SCROLL_KEY)) || 0;
  } catch {
    target = 0;
  }
  if (target <= 0) return;
  let tries = 0;
  const tick = () => {
    // 页面已足够高、能滚到目标 → 恢复；否则等下一帧内容继续渲染。
    const maxY = document.documentElement.scrollHeight - window.innerHeight;
    if (maxY >= target || tries >= 30) {
      window.scrollTo({ top: target, left: 0, behavior: 'instant' });
      return;
    }
    tries++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// —— 启动 ——
initNotifyButton();
initMuteToggle();
initChips();
initSearch();
initInstall();

// 每秒就地刷新时长文本（轻量，不重建 DOM、不触发过渡动画）。
setInterval(() => {
  tickDurations(app, { sessions, serverSkewMs });
}, 1000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

connect();

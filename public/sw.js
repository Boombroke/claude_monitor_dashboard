// ccmon service worker — M1 极简版：缓存 app 壳，处理 push（M3 接入 Web Push）。
const CACHE = 'ccmon-v11';
const SHELL = ['/', '/index.html', '/app.js', '/ui.js', '/styles.css', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // SSE / API / hooks 一律走网络，绝不缓存。
  if (url.pathname.startsWith('/events') || url.pathname.startsWith('/api') || url.pathname.startsWith('/hooks')) {
    return;
  }
  // 静态资源：网络优先、回退缓存。
  // 这样只要服务在跑，刷新永远拿到最新代码（避免旧前端被缓存卡住）；离线才用缓存兜底。
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // 顺带更新缓存。
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || Response.error())),
  );
});

// M3：Web Push
self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    /* ignore */
  }
  const title = data.title || 'ccmon';
  e.waitUntil(self.registration.showNotification(title, { body: data.body || '' }));
});

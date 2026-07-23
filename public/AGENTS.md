# public — ZERO-BUILD PWA

Vanilla-JS ES modules served as-is. **No bundler, no framework, no TypeScript, no build step.**

## FILES
- `app.js` — state + SSE client + filtering + timeline fetch + install prompt + notifications.
- `ui.js` — pure render layer (state → DOM); `renderSessions`, `STATE_LABEL`, `EFFORT_LABEL`, `normEffort`.
- `sw.js` — service worker (offline shell + caching policy).
- `styles.css` · `index.html` · `pairing.html` (LAN/ntfy QR page) · `manifest.webmanifest` · `icon.svg`.

## CONTRACT WITH BACKEND
Consumes SSE `ServerEvent`s from `/events`: `snapshot` (first frame) · `session.update` · `session.remove` · `notification`. The `Session` shape mirrors `src/types.ts` — **keep both in sync** when fields change.

## KEY BEHAVIORS
- `app.js` holds a `sessions` Map. `structuralSig()` gates the **View Transition**: only structure changes (add/remove/state) animate; content-only updates render immediately so expanded cards don't freeze on a stale snapshot.
- Token propagation: `?token=` from the URL is appended to SSE + every `/api` call via `withToken()`.
- `ui.js`: `normEffort` maps `ultracode`→`xhigh`; attention states pin to top; `DONE_BURST_MS` must match the `done-burst` animation in `styles.css`.
- `sw.js`: **SSE / `/api` / `/hooks` are network-only, NEVER cached** (sw.js:17); static assets are network-first with cache fallback.

## ANTI-PATTERNS
- No build ⇒ write **browser-ready ES modules only** — no bare-specifier imports, no JSX/TS syntax.
- **Bump the cache version** (`CACHE = 'ccmon-vN'` in sw.js) on any frontend change, or stale caches persist.
- Workflow-activity chip shows objective facts only — **must not imply ultracode** (ui.js:319).

# src/server — FASTIFY SURFACE

HTTP + SSE + static PWA, plus helpers. Entry: `createHttpServer()` (http.ts:42).

## FILES
- `http.ts` — Fastify app: routes + auth hook.
- `sse.ts` — `SseHub` : SSE client registry + broadcast.
- `assets.ts` — dual-mode static asset resolver (disk vs SEA embed).
- `focus.ts` — bring a session's terminal to foreground (desktop side-effect).
- `net.ts` — `lanIPv4()` / `pairingUrl()`.
- `qr.ts` — pure-TS QR encoder → SVG (no npm dep).

## ROUTES (http.ts)
`GET /` + static · `/health` · `/api/sessions` · `/api/sessions/:id/timeline` · `/api/sessions/:id/history` · `/api/pairing` · `/api/ntfy-pairing` · `POST /api/ntfy-test` · `POST /api/sessions/:id/focus` · `GET /events` (SSE) · `POST /hooks`.

## AUTH MODEL
Enforced **only when `cfg.lan && cfg.token`** (loopback = open). Accepts `Authorization: Bearer <token>` **or** `?token=` query (query form lets phones open the UI from a QR link). `/health` always open.

## SSE (sse.ts)
`addClient` writes `text/event-stream`, sends `snapshot` first frame, `retry: 3000`, then a heartbeat ping. A failing `write` silently drops that client — never throws upward.

## SEA DUAL-MODE ASSETS (assets.ts)
- Dev: `@fastify/static` serves disk `public/`.
- SEA binary: `isSea()` → read embedded bytes via `node:sea` `getRawAsset`.
- `PUBLIC_ASSETS` must list every file the build embeds; adding a `public/` file means updating this list.
- `qr.ts` is loaded via **dynamic import** so its absence degrades gracefully to URL-only.

## SIDE-EFFECT / SECURITY
- `POST /api/sessions/:id/focus` **changes the desktop** (not read-only) and is enabled even in LAN mode — intentional (http.ts:166).
- focus.ts passes the terminal command as **positional arg `$1`** — NEVER string-concat into the shell, even from `$TERMINAL` (focus.ts:40).
- `/hooks` must not log `tool_input` (may contain secrets, http.ts:189).

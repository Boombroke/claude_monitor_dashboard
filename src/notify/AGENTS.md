# src/notify — NOTIFICATION PIPELINE

State transition → decide → dedup → suppress → throttle → coalesce → fan-out.

## FILES
- `notifier.ts` — `Notifier` orchestrator (`onTransition`).
- `desktop.ts` — `DesktopChannel` (macOS `osascript`).
- `ntfy.ts` — `NtfyChannel` (HTTP POST to ntfy.sh).
- `presence.ts` — TTY presence detection (`isUserPresentAtSession`).

## CLASSIFY (notifier.ts:80)
`NEEDS_APPROVAL` / `IDLE_INPUT` → **needs-you** (high) · `DONE_WAITING` → **done** (default) · `WORKING`→`DEAD` → **info** (low) · everything else → no notification.

## PIPELINE ORDER
1. **Dedup** — key = `sessionId:state:bucket`, `bucket = floor(now / notifyCooldownMs)`; drop if within cooldown.
2. **Presence-suppress** — **desktop only**. If the user is at the session's TTY, skip desktop. **ntfy is NEVER suppressed** (it's the away channel).
3. **Throttle** — per-channel token bucket: 5s window, capacity 1 (`BUCKET_*`).
4. **Coalesce** — ≥3 needs-you within 4s (`COALESCE_THRESHOLD`/`COALESCE_WINDOW_MS`) → one "N sessions need you" summary instead of N pings.

## CHANNEL CONTRACT (types.ts NotificationChannel)
- `handles(n)` decides routing: ntfy default takes **only needs-you** (`done` gated by `cfg.ntfyOnDone`); desktop takes all.
- `send()` returns `boolean` and **MUST catch its own errors — never throw to Notifier** (desktop.ts:5, types.ts:320).
- Body: `redact` → `state · project` only; ntfy context gated by `cfg.ntfy.includeContext`; desktop may include truncated title/prompt.

## ANTI-PATTERNS
- `onTransition` is **sync fire-and-forget** (`void this.handle(...)`) — never make it await.
- The front-end SSE `view` is always broadcast regardless of throttle/suppress (UI must reflect instantly).
- `presence()` failures fall back to "not present" (don't suppress on error).

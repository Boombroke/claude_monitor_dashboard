# src/core — STATE KERNEL

Signal fusion → one authoritative `SessionState`. The riskiest logic in the project.

## FILES
- `store.ts` — `InMemorySessionStore` : **composite-key** (`${agent}:${sessionId}`) keyed, pid sub-index, resume-aware, 50-event ring buffer. Provider-agnostic.
- `hub.ts` — `Hub` : provider-agnostic commit engine. `makeSink(agent)` → `SessionSink` (patch/setState/peek/markDead), IDLE/DONE debounce, store→SSE/notify/history fan-out; `keyOf(agent, id)`.
- `reconciler.ts` — `DefaultReconciler.reconcile()` : Claude's pure signal-fusion fn (file+hook+liveness → state), used by `providers/claude`. **Highest-risk.**
- `liveness.ts` — `LivenessReaper` (`kill -0` poll, driven by `ClaudeProvider`) + shared `isPidAlive`/`ttyOf`.

> `manager.ts` was **removed**: its generic commit/debounce/fan-out became `hub.ts`; its Claude ingestion became `providers/claude/provider.ts`.

## RECONCILER PRIORITY (reconciler.ts:102, top→bottom)
1. `liveness.alive === false` → **DEAD** (overrides everything).
2. **Fresh hook** (within `hookTtlMs` AND `file.statusUpdatedAt` not newer than `hook.at`): `permission_prompt`/`PermissionRequest`→NEEDS_APPROVAL · `idle_prompt`/`agent_needs_input`→IDLE_INPUT · `Stop`/`agent_completed`→DONE_WAITING · `Pre/PostToolUse`→WORKING.
3. **File status** authority: `busy`→WORKING · `waiting`+permission→NEEDS_APPROVAL · `waiting` other→IDLE_INPUT · `idle`→DONE_WAITING if unacked done-marker else IDLE.
4. Fallback: `markers.turnDoneMarkerAt`→DONE_WAITING, else `previous`.

- `bypassPermissions` mode **disables the NEEDS_APPROVAL path** (these sessions never prompt).
- A newer file (statusUpdatedAt > hook.at) means a new turn started → stale Stop hook is ignored.

## KEY BEHAVIORS
- **Debounce**: `Hub` commit (`core/hub.ts`, via the sink) debounces IDLE/DONE (`stateDebounceMs`=200ms) to absorb tool-boundary jitter; WORKING / needs-you / DEAD / `immediate` commit at once. All providers inherit this.
- **Resume**: `store.upsert()` with a new `pid` archives the old pid into `pastPids` and rebuilds the pid index — same `sessionId` reused, not a new session.
- **`needsAttention` is ALWAYS derived from state** in store — never trust a patch value.
- events ring buffer = 50 (`EVENTS_RING_MAX`). Reaper: DEAD after 2 consecutive misses (`deadThreshold`), 5s interval.

## ANTI-PATTERNS
- Don't put I/O or heavy work in `reconcile()` — it's a pure hot-path fn; inject `now` for tests.
- Don't set `needsAttention`/`stateSince` manually via patch — `setState` owns them.
- Store listener callbacks are wrapped in try/catch — a throwing subscriber must not break others.

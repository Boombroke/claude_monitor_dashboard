# src/providers — PER-AGENT INGESTION

Each agent CLI has a `Provider` that owns its own ingestion + state derivation and emits normalized results into the shared kernel via a per-agent `SessionSink`. The kernel (`core/hub` + `core/store`) is provider-agnostic.

## SEAM (`types.ts`)
- `AgentKind` = `'claude' | 'codex' | 'opencode'` (defined in root `src/types.ts`).
- `Provider` : `{ agent, start(sink), stop(), onPush?(body) }`.
- `SessionSink` (bound to one agent by `Hub.makeSink`): `now()` · `peek(sessionId)` · `patch(sessionId, patch)` · `setState(sessionId, state, {reason,detail,immediate})` · `markDead(sessionId, reason)`.
- `ProviderPatch` = `Partial<Session>` minus state-owned/identity fields — the normalized signal. **Providers work in RAW sessionId; the sink injects `agent` and computes the composite key.**

## PROVIDERS
| Dir | Transport | State source |
|-----|-----------|--------------|
| `claude/` | `~/.claude` fs watch (sessionsWatcher/transcriptTailer/subagentWatcher) + `/hooks` POST + pid reaper | `core/reconciler.ts` priority ladder |
| `codex/` | tail `~/.codex/sessions/**/*.jsonl` (`rollout.ts`) + `WORKING+stale`/`shutdown_complete` DEAD sweep | `reduceCodexState()` over `event_msg` types |
| `opencode/` | **push**: opencode plugin → `POST /ingest/opencode` (server port is random, no discovery) | `mapOpencodeEvent()` (busy/idle/retry + permission/question) |

- `claude/provider.ts` wraps the existing `watch/*` + `core/reconciler` + `core/liveness` (files still live under `core`/`watch`).
- `codex/rollout.ts` + `opencode/mapEvent.ts` are **pure + unit-tested** (state inference without I/O).
- `opencode/plugin.ts` embeds the forwarder plugin source + `installOpencodePlugin()` (writes `~/.config/opencode/plugin/ccmon-forwarder.js`); CLI: `ccmon install-opencode-plugin`.

## STATE-MODEL DELTAS
- opencode has no "done" concept → `busy→idle` synthesizes `DONE_WAITING` when `sink.peek().state === 'WORKING'`, else `IDLE` (mirrors Claude's `hasUnacknowledgedDone`).
- opencode `retry` → `WORKING` + `stateDetail`（no new `SessionState`; the 6-state union is frozen).
- Codex approval subtypes (`exec_approval_request`/`apply_patch_approval_request`/`request_permissions`) all → `NEEDS_APPROVAL`.

## ADD A NEW PROVIDER
1. `providers/<agent>/provider.ts` implementing `Provider`; keep any parsing/state logic in a pure sibling (testable).
2. Add `<agent>` to `AgentKind` (`types.ts`) + the `/ingest/:agent` allowlist (`server/http.ts`).
3. Build it in `src/index.ts` when enabled; add its enable flag/paths in `config.ts` (`providers.<agent>`).
4. Emit only via the sink — never touch the store/SSE directly.

## ANTI-PATTERNS
- Don't reach past the sink into store/hub/SSE — the sink is the whole contract.
- Don't add debounce/liveness reapers to the kernel — liveness is per-provider; debounce is the Hub's job.
- File-tailing providers: serialize per-file reads, never throw from handlers, guard `isSecretPath()` (same rules as `watch/`).

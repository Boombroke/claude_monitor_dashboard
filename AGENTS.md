# ccmon — PROJECT KNOWLEDGE BASE

**Generated:** 2026-07-17 · **Commit:** def07ef · **Branch:** main

## OVERVIEW
`ccmon` — local **multi-agent CLI** session monitor + notification center. Watches Claude Code (`~/.claude` files + hooks), **Codex** (`~/.codex` rollout JSONL), and **opencode** (plugin push), derives an authoritative per-session state (WORKING / NEEDS_APPROVAL / IDLE_INPUT / DONE_WAITING / IDLE / DEAD), and pushes desktop + ntfy notifications when a session "needs you". TypeScript run **without a build step** on Node ≥22; Fastify + chokidar + SSE backend; vanilla-JS PWA frontend; `node:sqlite` history.

## STRUCTURE
```
src/
├── cli.ts        # bin entry — subcommand router (start/status/doctor/[un]install-hooks/install-opencode-plugin)
├── index.ts      # startDaemon() — DI assembly root; builds Hub + enabled providers
├── config.ts     # loadConfig() + isSecretPath() denylist guard + truncateContext()
├── types.ts      # FROZEN CONTRACT — single source of truth for all modules
├── core/         # store · hub · reconciler · liveness  (provider-agnostic kernel)
├── providers/    # types(seam) · claude/ · codex/ · opencode/  (per-agent ingestion)
├── watch/        # sessionsWatcher · transcriptTailer · subagentWatcher (Claude fs inputs)
├── server/       # http · sse · assets · focus · net · qr  (Fastify surface)
├── notify/       # notifier · desktop · ntfy · presence
├── hooks/        # installer · doctor  (~/.claude/settings.json management)
└── db/           # history  (node:sqlite, WAL)
public/           # PWA: app.js (state/SSE) · ui.js (render) · sw.js · styles.css · *.html
scripts/          # build-sea.mjs — Node SEA single-binary packager
test/             # node:test, one *.test.ts per module (flat)
```

## DATA FLOW
Each `Provider` owns its own ingestion + reconcile and emits normalized `patch`/`setState` through a per-agent `SessionSink`:
- **Claude** (`providers/claude`): `sessionsWatcher` + `transcriptTailer` + `subagentWatcher` + `liveness` reaper + `DefaultReconciler`, plus `/hooks` POST.
- **Codex** (`providers/codex`): tails `~/.codex/sessions/**/*.jsonl`, infers state from `event_msg` types.
- **opencode** (`providers/opencode`): consumes `/ingest/opencode` pushes from its plugin.

`Hub` (`core/hub.ts`) binds each provider a sink, commits to `InMemorySessionStore` (keyed by composite `${agent}:${sessionId}`), applies IDLE/DONE debounce, and fans out → SSE broadcast to PWA + `Notifier` + `History`.

## WHERE TO LOOK
| Task | Location |
|------|----------|
| Add a new agent provider | implement `Provider` in `src/providers/<agent>/`; wire in `src/index.ts` + `src/config.ts` |
| Change Claude state rules | `src/core/reconciler.ts` (priority ladder), used by `providers/claude` |
| Change Codex / opencode state mapping | `providers/codex/rollout.ts` (`reduceCodexState`) / `providers/opencode/mapEvent.ts` |
| Change commit / debounce / fan-out | `src/core/hub.ts` |
| Change what the UI shows | `public/ui.js` (render) + `public/app.js` (state), `src/types.ts` `Session` |
| Add an HTTP/REST/SSE route | `src/server/http.ts` |
| Change notification logic | `src/notify/notifier.ts` |
| Add a config flag | `src/cli.ts` (parseArgs) + `src/config.ts` (loadConfig) + `src/types.ts` `Config` |

## CODE MAP
| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `startDaemon` | fn | index.ts | Assembly/DI root; builds Hub + providers; returns `{url, stop()}` |
| `Config`/`Session`/`ServerEvent`/`HookPayload`/`AgentKind` | types | types.ts | Cross-module frozen contract |
| `Provider`/`SessionSink`/`ProviderPatch` | types | providers/types.ts | Per-agent ingestion seam (raw sessionId; sink injects agent) |
| `Hub` | class | core/hub.ts | `makeSink(agent)` + `keyOf` + debounce + store→SSE/notify/history fan-out |
| `ClaudeProvider`/`CodexProvider`/`OpencodeProvider` | class | providers/*/ | Per-agent ingestion + reconcile |
| `DefaultReconciler` | class | core/reconciler.ts:93 | Claude signal fusion → state (**highest-risk logic**) |
| `InMemorySessionStore` | class | core/store.ts:29 | composite-key-keyed, pid sub-index, resume-aware |
| `createHttpServer` | fn | server/http.ts:42 | Fastify: static PWA + /events + /api/* + /hooks + /ingest/:agent |
| `Notifier` | class | notify/notifier.ts:49 | dedup + presence-suppress + throttle + coalesce |

## CONVENTIONS
- **Node ≥22 hard requirement.** Runs `.ts` directly (`node src/cli.ts`); `bin` points at `src/cli.ts`. No transpile.
- **`tsc` is type-check only** (`noEmit: true`). There is no compiled `dist/` for normal use.
- **`verbatimModuleSyntax: true`** → type-only imports MUST use `import type { ... }`.
- **Imports use `.ts` extension** (`allowImportingTsExtensions`), e.g. `import { X } from './core/store.ts'`.
- **`noUncheckedIndexedAccess: true`** → indexed access is `T | undefined`; guard or `!` after a proven bound.
- **`"type": "module"`** — pure ESM; no `require` except `node:sea` shim in `server/assets.ts`.
- **DI everywhere** — constructor `deps` objects + injectable `now: () => number` for deterministic tests.
- **Graceful degradation** — `try { … } catch { /* comment */ }` is intentional (history, presence, QR, desktop all optional). Empty catches here are by design, not slop.
- **Comments & UI copy are Simplified Chinese.** Match this when editing.
- **No linter/formatter, no CI.** Style is enforced by hand + `npm run typecheck`.

## ANTI-PATTERNS (THIS PROJECT)
- **NEVER read/record** `~/.claude/ide/*.lock` or `~/.claude/daemon/control.key` — see `SECRET_PATH_DENYLIST` (types.ts:421); every watcher calls `isSecretPath()` first.
- **NEVER log `tool_input`** at info level or put secret/token/`tool_input` raw text in `SessionEvent.detail` (types.ts:113, http.ts:189).
- **NEVER surface raw transcript full-text above the data layer** — UI/notify consume only the normalized `Session` (types.ts:52).
- **NEVER derive `cwd` from the slug** — `slugFromCwd` is LOSSY/irreversible (types.ts:61, transcriptTailer.ts:84).
- **Event handlers & channel `send()` MUST NOT throw** — swallow internally (transcriptTailer.ts:14, desktop.ts:5, history.ts:12).
- **Do NOT `git commit` without explicit request.** Never commit `.ccmon/`, `ccmon.sqlite*`, `dist/` (see .gitignore).

## COMMANDS
```bash
npm start            # node src/cli.ts start      → http://127.0.0.1:7420
npm run dev          # node --watch src/cli.ts start
npm run typecheck    # tsc -p tsconfig.json  (type-check only)
npm test             # node --test 'test/**/*.test.ts'  (37 tests, node:test)
npm run build:sea    # node scripts/build-sea.mjs → dist/ccmon (~138MB SEA binary)
```

## NOTES
- **Multi-agent**: Claude (fs + `/hooks`), Codex (`~/.codex` rollout tail; `CCMON_CODEX_HOME`), opencode (plugin push → `/ingest/opencode`; run `ccmon install-opencode-plugin` — opencode's server port is random so push is the only reliable path). Toggle per agent via `CCMON_ENABLE_{CLAUDE,CODEX,OPENCODE}=0`. Store keys are composite `${agent}:${sessionId}`; `Session.sessionId` stays raw.
- **Designed for macOS host** (`osascript`/`ioreg` for desktop notify + presence + terminal focus); degrades gracefully on Linux (ntfy still works). This repo currently runs on Linux.
- **Docker on macOS is unsupported** (VM can't see host pids/files) — README §"关于 Docker".
- Sessions run with `--dangerously-skip-permissions` never fire approval hooks → fall back to file `waiting` status.
- `build:sea` needs an **official nodejs.org** Node binary in `.node-official/` (Homebrew node lacks the SEA fuse); or set `CCMON_BASE_NODE`.
- Config precedence: CLI flags > env (`CCMON_*`) > `~/.config/ccmon/config.json` > defaults. `CCMON_CLAUDE_DIR` redirects the `~/.claude` root (used by tests).

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Deep knowledge base

The root **`AGENTS.md`** is the authoritative, always-current knowledge base (overview, data flow, code map, anti-patterns). Each `src/` subsystem also has its own `AGENTS.md` (`core/`, `providers/`, `watch/`, `server/`, `notify/`, `hooks/`, plus `public/` and `test/`). **Read the relevant `AGENTS.md` before editing a subsystem** — this file is the fast-start subset; those are the detail.

## What this is

`ccmon` — a local monitor + notification center for multi-agent CLI sessions. It watches **Claude Code** (`~/.claude` files + optional hooks), **Codex** (`~/.codex` rollout JSONL), and **opencode** (plugin push), derives one authoritative per-session state (`WORKING` / `NEEDS_APPROVAL` / `IDLE_INPUT` / `DONE_WAITING` / `IDLE` / `DEAD`), and fires desktop + [ntfy](https://ntfy.sh) notifications when a session "needs you". Fastify + chokidar + SSE backend; vanilla-JS PWA frontend; `node:sqlite` history.

## Commands

```bash
npm start                         # node src/cli.ts start  → http://127.0.0.1:7420
npm run dev                       # same, with node --watch
npm run typecheck                 # tsc -p tsconfig.json  (type-check ONLY; noEmit)
npm test                          # node --test 'test/**/*.test.ts'
node --test test/hub.test.ts      # run ONE test file
node --test --test-name-pattern="<regex>" 'test/**/*.test.ts'   # run tests matching a name
npm run build:sea                 # esbuild bundle → Node SEA single binary (dist/ccmon)

# CLI subcommands (via src/cli.ts):
node src/cli.ts status            # one-shot session dump, no server
node src/cli.ts doctor            # environment health check
node src/cli.ts install-hooks --dry-run   # preview ~/.claude/settings.json hook merge
node src/cli.ts install-hooks             # install (auto-backup, lossless merge)
node src/cli.ts install-opencode-plugin   # install the opencode forwarding plugin
```

There is **no lint step and no CI** — correctness is `npm run typecheck` + `npm test` by hand.

## Architecture (the big picture)

The kernel is **provider-agnostic**; each agent type is a self-contained ingestion `Provider`.

- **`src/index.ts` `startDaemon()`** is the DI assembly root: it reads `Config`, builds the `Hub`, constructs each enabled `Provider`, and starts the HTTP server. Returns `{ url, stop() }`.
- **`src/providers/<agent>/`** — each `Provider` (Claude / Codex / opencode) owns its own file watching / tailing / reconcile logic and emits normalized `patch` / `setState` through a per-agent `SessionSink`. The sink injects the `agent` tag; providers only ever see a raw `sessionId`. The seam is `src/providers/types.ts`.
  - **Claude**: `watch/` (`sessionsWatcher` + `transcriptTailer` + `subagentWatcher`) + `core/liveness` reaper + `core/reconciler` (`DefaultReconciler` — the signal-fusion priority ladder, the highest-risk logic), plus low-latency `/hooks` POSTs.
  - **Codex**: tails `~/.codex/sessions/**/*.jsonl`; state inferred in `providers/codex/rollout.ts` (`reduceCodexState`).
  - **opencode**: opencode's server port is random, so it can't be polled — its installed plugin *pushes* events to `/ingest/opencode`; mapped in `providers/opencode/mapEvent.ts`.
- **`src/core/hub.ts` `Hub`** is the convergence point: `makeSink(agent)`, composite key `${agent}:${sessionId}`, commits to `InMemorySessionStore`, applies IDLE/DONE debounce, then fans out → SSE broadcast + `Notifier` + `History`.
- **`src/server/http.ts`** — Fastify surface: static PWA, `/events` (SSE), `/api/*`, `/hooks`, `/ingest/:agent`.
- **`src/notify/notifier.ts`** — dedup + presence-suppression (don't ping while you're watching the terminal) + throttle + coalesce, over desktop + ntfy channels.
- **`public/`** — PWA: `app.js` (SSE/state) + `ui.js` (render) + `sw.js` (service worker) + `styles.css`. Bump the SW cache version in `sw.js` when shipping frontend changes.

**`src/types.ts` is a frozen cross-module contract** (`Config`, `Session`, `ServerEvent`, `HookPayload`, `AgentKind`, …) — the single source of truth every module depends on.

### Where to make common changes
| Task | Location |
|------|----------|
| Add a new agent provider | new `src/providers/<agent>/`; wire into `src/index.ts` + `src/config.ts` |
| Change Claude state rules | `src/core/reconciler.ts` |
| Change Codex / opencode state mapping | `providers/codex/rollout.ts` / `providers/opencode/mapEvent.ts` |
| Change commit / debounce / fan-out | `src/core/hub.ts` |
| Change what the UI shows | `public/ui.js` + `public/app.js`; the `Session` shape in `src/types.ts` |
| Add an HTTP/SSE route | `src/server/http.ts` |
| Change notification logic | `src/notify/notifier.ts` |
| Add a config flag | `src/cli.ts` (parseArgs) + `src/config.ts` (loadConfig) + `src/types.ts` `Config` |

Config precedence: **CLI flags > `CCMON_*` env > `~/.config/ccmon/config.json` > defaults.** Per-agent toggle via `CCMON_ENABLE_{CLAUDE,CODEX,OPENCODE}=0`; `CCMON_CLAUDE_DIR` / `CCMON_CODEX_HOME` redirect the watched roots (tests use these).

## Conventions that override default behavior

- **Node ≥22 hard requirement; NO build step.** `.ts` runs directly (`node src/cli.ts`), `bin` points at `src/cli.ts`, and `tsc` is `noEmit` type-check only. There is no `dist/` in normal use.
- **`verbatimModuleSyntax: true`** → type-only imports MUST be `import type { … }`.
- **Imports use the `.ts` extension** (`allowImportingTsExtensions`), e.g. `import { X } from './core/store.ts'`.
- **`noUncheckedIndexedAccess: true`** → indexed access is `T | undefined`; guard it, or `!` only after a proven bound.
- **Pure ESM** (`"type": "module"`) — no `require` except the `node:sea` shim in `server/assets.ts`.
- **DI everywhere**: constructor `deps` objects and an injectable `now: () => number` for deterministic tests.
- **Empty `catch {}` blocks are intentional** — history, presence, QR, and desktop notify are all optional and degrade gracefully. These are by design, not sloppiness. Event handlers and channel `send()` must never throw.
- **Comments and UI copy are Simplified Chinese.** Match the surrounding language when editing.
- **Do NOT `git commit` without an explicit request.** Never commit `.ccmon/`, `ccmon.sqlite*`, `*.ccmon-bak-*`, or `dist/` (see `.gitignore`).

## Anti-patterns (will break security/privacy invariants)

- **NEVER read or record** `~/.claude/ide/*.lock` or `~/.claude/daemon/control.key` — they contain secrets. Every watcher calls `isSecretPath()` first; see `SECRET_PATH_DENYLIST` in `types.ts`.
- **NEVER log `tool_input`** at info level, and never put secret/token/`tool_input` raw text into `SessionEvent.detail`.
- **NEVER surface raw transcript full-text above the data layer** — UI and notifications consume only the normalized `Session`.
- **NEVER derive `cwd` from the session slug** — `slugFromCwd` is lossy and irreversible.

## Platform notes

- Built for **macOS host** (`osascript` / `ioreg` for desktop notify, presence, terminal focus); degrades gracefully on Linux (ntfy still works). This repo currently runs on Linux.
- **Docker on macOS is unsupported** (the Linux VM can't see host pids/files) — see README §"关于 Docker".
- Sessions run with `--dangerously-skip-permissions` never fire approval hooks → they fall back to the file `waiting` status.
- `build:sea` needs an **official nodejs.org** Node binary in `.node-official/` (Homebrew's Node lacks the SEA fuse), or set `CCMON_BASE_NODE`.

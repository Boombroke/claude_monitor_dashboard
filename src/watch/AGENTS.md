# src/watch — FILESYSTEM INPUT ADAPTERS

Turn `~/.claude` file activity into normalized signals. Never emit raw transcript text.

## FILES
- `sessionsWatcher.ts` — watches `sessions/*.json` → `SessionFileSnapshot` (add/change), pid (unlink). `parseSessionFile()` is pure/exported.
- `transcriptTailer.ts` — incrementally tails `projects/<slug>/<sessionId>.jsonl` → `TranscriptMarkers`. Largest/most-complex file (579 lines).
- `subagentWatcher.ts` — sweeps `<slug>/<sessionId>/subagents/**` + `wf_*` → `SubagentStats` (token footprint + workflow telemetry).

## CHOKIDAR v4 CONSTRAINT
v4 **removed glob support** → watch the *directory*, filter by extension/`depth` in `ignored` (sessionsWatcher.ts:82; tailer watches `projectsDir` depth 2). Don't reintroduce glob strings.

## TRANSCRIPT TAILER INTERNALS
- Driven by `manager` via `track()`/`untrack()` — only live sessions are tailed (not the whole tree).
- Per-file byte `offset`; `size < offset` ⇒ truncation/rotation ⇒ reset to 0 & rescan.
- `track()` bootstraps by reading only the **tail 64KB** (`BOOTSTRAP_TAIL_BYTES`), not the whole file.
- Per-session `chain: Promise<void>` **serializes reads — NEVER concurrent** (tailer.ts:35).
- Retains trailing partial bytes across reads so multibyte UTF-8 isn't split at chunk edges.
- `effortEcho` (from `extractEffortEcho`) is the **only** signal distinguishing ultracode (hooks report it as `xhigh`). **NEVER clear it on compaction/rotation** (tailer.ts:543).
- `computeContextTokens` = sum of 4 `usage` fields. `inferContextWindow` → 200K vs 1M heuristic (model family / `[1m]` tag / tokens>200K).

## SUBAGENT WATCHER
- Single 5s sweep timer; **mtime+size skip** unchanged files (dead sessions = zero reads); cross-slug merge by `sessionId`; 30s slug-dir cache; signature debounce (no emit if unchanged). **NEVER full re-parse every second** (watcher.ts:12).
- Token footprint = Σ per-agent peak — cumulative compute spend, **not** current context.

## ANTI-PATTERNS
- Event handlers **MUST NOT throw** (tailer.ts:14) — wrap and swallow.
- `slugFromCwd` is **LOSSY / irreversible** — never reconstruct `cwd` from a slug (tailer.ts:84).
- Call `isSecretPath()` before every read (sessionsWatcher.ts:107) even if the dir looks safe.

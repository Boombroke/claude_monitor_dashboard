# src/hooks — CLAUDE settings.json MANAGEMENT

Install/remove ccmon's Claude Code hooks; environment health check.

## FILES
- `installer.ts` — `installHooks()` / `uninstallHooks()` + pure helpers `buildHookEntries` / `computeMergedSettings` / `diffSettings`.
- `doctor.ts` — `runDoctor()` : Node version, sessions dir, hook status, port checks.

## SAFE-MERGE SEMANTICS (installer.ts)
- **Sentinel** `CCMON=1` (a harmless env assignment prefixed to each hook command) marks entries this tool owns.
- Every merge **strips old owned entries, then re-appends fresh ones** → idempotent (run twice = identical result).
- **Lossless**: entries WITHOUT the sentinel are left untouched — never rewrite someone else's hooks.
- Writes are **backup-first**; `--dry-run` prints the diff and writes nothing.

## HOOKS INSTALLED
`Notification`(matchers `permission_prompt`, `idle_prompt`) + `Stop` + `SessionStart`. All `async:true, timeout:3`; each is a `curl` that POSTs the hook's stdin JSON to `http://127.0.0.1:<port>/hooks` (with Bearer header when a token exists). `SessionStart` carries `effort.level` to capture the session's real reasoning effort.

## ANTI-PATTERNS
- Only ever read/write `settings.json` — **NEVER** `ide/*.lock` or `daemon/control.key` (installer.ts:8).
- Keep `buildHookEntries` / `computeMergedSettings` / `diffSettings` **pure** — they're unit-tested without disk I/O.
- `doctor` output must not leak secrets/tokens.

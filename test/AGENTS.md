# test — node:test SUITE

Built-in `node:test` + `node:assert/strict`. No Jest/Vitest/Mocha. 37 tests, flat dir, one `<module>.test.ts` per source module (e.g. `transcriptTailer.ts` → `tailer.test.ts`).

## RUN
```bash
npm test    # node --test 'test/**/*.test.ts'
```
No CI exists — run manually. Node ≥22 required (runs `.ts` directly).

## ISOLATION RULES (mandatory)
- **FS tests** (`tailer`, `subagentWatcher`): `mkdtempSync(join(tmpdir(),'ccmon-*'))` + `rmSync(..., {recursive,force})`. **NEVER touch real `~/.claude`.**
- Redirect the Claude root via `CCMON_CLAUDE_DIR` env, then restore it right after `loadConfig()` captures the value (avoid polluting other tests).
- **DB tests**: `new History(':memory:')` — no disk.
- **Time**: inject `now: () => number`. **Presence/channels**: inject a fake `NotificationChannel` / `presence` fn to avoid `osascript`/network.

## STYLE
Flat `test('<中文描述>', () => { … })` — Chinese descriptive names, **no `describe` blocks, no nesting**. Assertions via `assert` from `node:assert/strict`.

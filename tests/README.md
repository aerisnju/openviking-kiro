# Offline test suite

All tests are **offline**: they parse hand-authored fixtures, check envelopes,
and write only into throwaway `--prefix` temp dirs. None contact the OpenViking
cloud, and none create/modify/delete remote data or the real installer target.

## Running

```powershell
node --test "tests/**/*.test.mjs"
```

(`npm test` runs the same command. Node 24 treats a bare `node --test tests/`
argument as a module path, so the glob form is used.)

## One-time dev prerequisite

The host modules import the shared runtime via the relative path
`../../memory-plugin-shared/lib`, which resolves to a **sibling of this repo**
(`<repo-parent>/memory-plugin-shared/lib`) — the same layout the installer
produces under `~/.openviking/agent-integrations/`. For the tests to resolve
those imports in the dev checkout, make that sibling point at the already
installed shared closure. On Windows:

```powershell
New-Item -ItemType Junction `
  -Path "<repo-parent>\memory-plugin-shared" `
  -Target "$env:USERPROFILE\.openviking\agent-integrations\memory-plugin-shared"
```

This junction is read-only usage of the installed closure; the tests never
write through it. The installer/uninstaller tests do not need it — they stub the
shared lib inside their temp `--prefix` dir.

## Coverage

- `kiro-turns.test.mjs` — the `messages.jsonl` allow-list parser (turn
  ordering, `Say`-only, incremental cursor, duplicate-Stop, trailing-user
  pending, Stop-before/after-assistant single capture, sub-agent negative).
- `kiro-session.test.mjs` — the session locator (glob primary, index secondary,
  `sess_`-prefix tolerance both ways and both paths, present-but-unmatched
  once-per-session log, missing, mtime tertiary).
- `kiro-guard.test.mjs` — the ask-not-deny PreToolUse envelope + tool-name map.
- `kiro-install.test.mjs` — the installer/uninstaller against a temp `--prefix`
  (preflight, v1 hook files, MCP merge, bundle copy, idempotency, ovcli.conf
  untouched, steering/skill, uninstall selectivity).

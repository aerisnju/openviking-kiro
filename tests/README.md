# Offline test suite

All tests are **offline**. They use hand-authored fixtures, temp directories
(created under the OS temp dir with an `ov-kiro-` prefix and removed when the
test process exits) and, for the end-to-end tests, a stub HTTP server bound to
`127.0.0.1`. None contacts an OpenViking server or any other remote host, and
none writes to `~/.kiro`, `~/.openviking` or an upstream clone.

## Running

```powershell
npm test
```

`npm test` runs `scripts/check-test-prereqs.mjs` (`pretest`) and then
`node --test "tests/**/*.test.mjs"`. Node 24 treats a bare `node --test tests/`
argument as a module path, so the quoted glob form is used.

## One-time dev prerequisite

The host modules import the shared runtime via the relative path
`../../memory-plugin-shared/lib`, which resolves to a **sibling of this repo**
(`<repo-parent>/memory-plugin-shared/lib`), the same layout the installer
produces under `~/.openviking/agent-integrations/`. Make that sibling point at
the shared runtime that an official OpenViking memory plugin installed. On
Windows:

```powershell
New-Item -ItemType Junction `
  -Path "<repo-parent>\memory-plugin-shared" `
  -Target "$env:USERPROFILE\.openviking\agent-integrations\memory-plugin-shared"
```

On macOS / Linux:

```sh
ln -s ~/.openviking/agent-integrations/memory-plugin-shared <repo-parent>/memory-plugin-shared
```

The link is only read through; the tests never write to it. The pretest check
prints these commands (with real paths) when the link is missing. The
installer/uninstaller tests do not need it: they stub the shared lib in their
temp `--prefix` dir.

## Coverage

- `kiro-capture.test.mjs` — **`kiro.capture()` end to end in process** with a
  stub `fetchJSON`: posts the user and assistant turns, commits, advances
  `lastTurnId` / `capturedTurnIds` / `capturedSinceCommit`, is a no-op on a
  repeat Stop, sends only a new turn, sends a user-before-assistant Stop exactly
  once, handles failed sends/commits and an unresolved session. Includes the
  regression guard for the `{status, turns}` contract. Also: injected records
  never reach the POST body, assistant-only turns are captured once, step
  sessions read/send/commit nothing (and a human session beside one still
  captures), and an unreadable or missing `session.json` is retried on the
  next Stop and captured exactly once.
- `kiro-capture-e2e.test.mjs` — **the real Stop hook**: runs the real installer
  into a temp prefix, then `node <bundle>/scripts/hook.mjs stop kiro` as a
  subprocess with an isolated environment and a stub OpenViking server on
  loopback; asserts the messages and commit requests, the written hook state,
  the User-Agent version, and that the debug log has no `uncaught` error; also
  a session with injected records (only human text is POSTed, drop counts are
  logged) and a step session (no request at all, skip logged once). Not
  covered: Kiro itself, the real OpenViking server, shell quoting of the hook
  command.
- `kiro-adapter-contract.test.mjs` — the adapter object against the fields
  upstream's `hook.mjs` / `uri-guard.mjs` read, `stages`, `envelope`, request
  budgets versus the installed hook timeouts, version agreement, bundle
  contents.
- `check-upstream.test.mjs` — `scripts/check-upstream.mjs` against a fake
  upstream git repo and fake installed lib (identical, drift, `--sync`, class
  B/C warnings, breaking imports, dirty upstream, read-only guarantee), plus
  consistency of the real `upstream.lock.json` with the tree.
- `check-test-prereqs.test.mjs` — the `pretest` check and the npm scripts.
- `kiro-turns.test.mjs` — the `messages.jsonl` allow-list parser (turn
  ordering, `Say`-only, incremental cursor, duplicate-Stop, trailing-user
  pending, Stop-before/after-assistant single capture, sub-agent negative),
  plus mixed sessions with synthetic injected records (only human text is
  sent, nothing is glued onto the next prompt, huge events, old-build records,
  assistant-only turns).
- `kiro-user-records.test.mjs` — `classifyKiroUserRecord()` per record shape:
  human shapes of every Kiro era kept (multi-line, long pasted, non-ASCII,
  documents/images), steer with `notification` / `steeringClearedIds` / empty
  text, synthetic messages, text envelopes, oversized structured text, and the
  deliberately narrow cases that are kept (steer without notification meta).
- `kiro-session-kind.test.mjs` — step vs human vs unknown from `session.json`
  (each of the three marker keys, non-markers, missing/invalid/unreadable file).
- `kiro-session.test.mjs` — the session locator (glob primary, index secondary,
  `sess_`-prefix tolerance both ways and both paths, present-but-unmatched
  once-per-session log, missing, mtime tertiary).
- `kiro-guard.test.mjs` — the ask-not-deny PreToolUse envelope + tool-name map.
- `kiro-uri-guard-entrypoint.test.mjs` — `scripts/uri-guard.mjs` as a process.
- `kiro-install.test.mjs` — the installer/uninstaller against a temp `--prefix`
  (preflight, v1 hook files, MCP merge, bundle copy, dry-run plan, idempotency,
  ovcli.conf untouched, steering/skill, uninstall selectivity).

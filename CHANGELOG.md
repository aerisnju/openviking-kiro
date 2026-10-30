# Changelog

## 0.1.2

**Fixes capture of Kiro-injected messages as if the user had said them, and stops
capturing workflow/sub-agent step sessions.**

- Kiro writes more than human prompts as `user` records in `messages.jsonl`:
  workflow events (`source: "steer"`, `_kiro/workflow/*` JSON-RPC, step reports,
  some over 80,000 characters) and synthetic messages (`[WORKFLOW NOTIFICATION]`,
  `A workflow you launched (...)`). 0.1.1 sent all of them to OpenViking as user
  speech and glued them onto the next real prompt. The parser now drops them
  before they can become user text (`hosts/kiro-user-records.mjs`; rules in
  [DESIGN.md](./DESIGN.md) section 6). Genuine prompts are kept, including
  multi-line, long pasted, non-ASCII and older-build records without `source` or
  `_meta`.
- A turn whose user part was entirely injected still has the agent's reply
  (for example its answer after a workflow finished); that reply is captured.
- Each workflow/sub-agent step runs as its own Kiro session, and 0.1.1 created
  one cloud session per step. Step sessions are no longer captured: the Stop
  hook skips a session whose `session.json` marks it as a step. Session start
  and prompt recall are unchanged for those sessions.
- If `session.json` is missing or unreadable at Stop time, that Stop is skipped
  without advancing the cursor, and the next Stop retries.
- With debug logging on, the Stop hook logs drop counts per reason
  (`capture_user_records_dropped`) and skipped sessions
  (`capture_skipped_step_session`, `capture_deferred_session_kind_unknown`).
  Counts, reasons and session ids only, never message content.
- **Data already written by 0.1.1 is not cleaned up automatically.** Injected
  messages and step sessions captured earlier stay in OpenViking until you delete
  them yourself.

## 0.1.1

**Fixes a bug that made the Stop hook capture nothing in 0.1.0.**

- `kiro.capture()` passed the `{ status, turns }` object returned by
  `buildKiroTurns()` to the plan builder, which iterates an array. Every Stop
  threw `turns is not iterable` before any request was sent, and `hook.mjs`
  swallows errors by design, so nothing showed. With 0.1.0 installed, no
  conversation was captured or committed to OpenViking by the Stop hook. Recall
  at session start and prompt submit, the URI guard and the MCP server were not
  affected. Now fixed, and a non-`ok` transcript status is written to the debug log.
- Added tests that run the real capture flow: `kiro.capture()` in process with a
  stub `fetchJSON`, and the real Stop hook as a subprocess against a stub server
  on loopback. The 0.1.0 suite never called `kiro.capture()`.

Re-synced with upstream OpenViking plugin 0.5.29 (commit `14fa24dc5`):

- `scripts/hook.mjs` and `hosts/incremental-turn-capture.mjs` updated; new
  `scripts/request-budget.mjs`. The latter changes every hook request to share
  one deadline, and `incremental-turn-capture.mjs` no longer sends duplicate
  messages from one batch twice.
- Request budgets for session start (25 s) and prompt submit (17 s) were added
  to the Stop budget (25 s), all below the hook timeouts.
- The skill text gained upstream's note not to use `write`/`edit` to store
  files, URLs or skills.
- The User-Agent now carries the integration version (`OPENVIKING_INTEGRATION_*`).

New maintenance tooling:

- `upstream.lock.json` records which upstream commit and blob each copied or
  mirrored file came from.
- `scripts/check-upstream.mjs` (`npm run check-upstream`, `npm run sync-upstream`)
  reports drift against a local clone of `volcengine/OpenViking`, verifies the
  symbols imported from the shared runtime, and re-copies the verbatim files.
- `npm test` now checks first that the shared runtime sibling is reachable and
  prints the one-time fix if not.
- `.gitattributes` keeps the copied files LF on every platform.
- NOTICE and DESIGN.md corrected (four verbatim files; upstream `examples/` is
  Apache-2.0); README gained the sync runbook and known limitations.

## 0.1.0

Initial release: four user-level Kiro hooks (session start, prompt submit, URI
guard, Stop capture), an `openviking` MCP server entry, a Node installer and
uninstaller, and offline tests. The Stop capture did not work (see 0.1.1).

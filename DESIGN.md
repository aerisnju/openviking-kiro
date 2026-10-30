# OpenViking Memory for Kiro — Why Kiro Differs from ZCode

This project adds Kiro as a new **thin host** on OpenViking's existing `agent-hook-plugin`
framework. All memory logic (recall, capture filtering, HTTP, retry queue, MCP transport,
credentials, session model) is **reused by import** from
`~/.openviking/agent-integrations/memory-plugin-shared/lib`, exactly as the ZCode host does.
The Kiro bundle installs into `~/.openviking/agent-integrations/kiro/` beside the shared
sibling so the `../../memory-plugin-shared/lib` relative import resolves with zero rewriting.

Kiro is close to ZCode but differs in five concrete ways. Each was verified against a live Kiro build at authoring time;
this doc records **why** the Kiro host looks different from the ZCode host.

## 1. Hook file format — per-file `v1` schema (VERIFIED)

ZCode keeps hooks in a single `~/.zcode/cli/config.json` and requires `hooks.enabled:true`.
Kiro uses **one file per hook** under `~/.kiro/hooks/<id>.json` in its own schema:

```json
{ "version": "v1", "hooks": [{
  "name": "<Name>",
  "trigger": "SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|Stop",
  "matcher": "<optional regex>",
  "action": { "type": "command", "command": "node \"<abs path>\" <event> kiro", "timeout": 30 }
}] }
```

- `trigger` names are **PascalCase**.
- `matcher` is a **sibling of `action`** (top level of the hook object) and, for `PreToolUse`,
  is tested against the **tool name**.
- `timeout` is in **seconds** (Kiro's unit).
- Files load at **user scope** from `~/.kiro/hooks/`.

**How this was verified:** Kiro's own `createHook` tool wrote hook files to
`~/.kiro/hooks/<id>.json` in exactly this shape, and a `PostToolUse` probe **fired 7×** live —
each firing recorded by Kiro as a `messages.jsonl` payload of type `ContextualHookInvoked`,
status `completed`. So user-level hook loading **and** firing are proven, not assumed.

The installer therefore **renders the four Kiro v1 files directly** (from an in-code
`{event, script, trigger, timeout, matcher?}` table) instead of merging into a shared config,
and identifies its own files by an `openviking-` filename prefix. An **optional**
`install.mjs --verify` self-check re-reads and `JSON.parse`s each written file and asserts its
shape — **defense-in-depth, not a gate**, since the schema is confirmed.

## 2. `permissionDecision:"ask"`, never `"deny"` (VERIFIED)

ZCode's `PreToolUse` guard emits `permissionDecision:"deny"`. **Kiro does not support `"deny"`.**
Per Kiro's hook docs, an exit-0 `PreToolUse` stdout may carry
`{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"<text>"}}`, and
`"ask"` prompts the user. The Kiro guard therefore reuses the shared URI detection
(`evaluateUriGuard`, `readToolEvent`, `findVikingUri`) but wraps the result in an **`ask`**
envelope, making the guard **advisory** (surface a permission prompt steering toward the
OpenViking MCP tools) rather than a hard block. The envelope carries
`hookEventName:"PreToolUse"` to match the shared deny envelope and this host's own
SessionStart/UserPromptSubmit envelopes — the safe, documented shape. Returning `{}`
(no keys) means "no opinion" and the tool proceeds.

## 3. Capture from `messages.jsonl` — not a rollout file

ZCode reads a per-session rollout whose lines already pair `request.messages` +
`response.text` under a monotonic `turnId`. Kiro's transcript is
`~/.kiro/sessions/<shortId>/<sessId>/messages.jsonl`: **append-only, one record per line**,
each `{id, timestamp, payload}`, with many `payload.type`s where user / assistant / tool
records are separate and grouped by `executionId` (the stable per-turn id).

Because several non-conversation types (`turn_end`, `sub_agent_*`, `tool_*`) also carry an
`executionId`, the parser is **allow-list driven**:

- only `turn_start` orders a turn,
- only `assistant` with `operationType === "Say"` contributes assistant text,
- only `user` contributes user text, and only when it is not harness-injected (section 6).

`user` records carry **no** `executionId`, so a pending user message is attached to the next
execution purely by **ordering** (the Kimi Code pattern, not ZCode) and does **not** depend on
`_meta.kiro.userMessageTag`, which is present only in newer builds. If a Stop fires before any
assistant `Say`, the trailing user is **left pending** (no synthetic turn) and captured on the
next Stop under its real `executionId` — this avoids a double-send that a synthetic,
per-record id would cause. Capture is **inline** under a `requestBudgets` entry of 25 s for
Stop (17 s for UserPromptSubmit and 25 s for SessionStart, the same values as upstream's ZCode
adapter), so each hook ends before its Kiro timeout (30 / 20 / 30 s) and the cursor state always
persists; an aborted write is enqueued and replayed on the next SessionStart.

**Capture contract.** `extractUnseenKiroTurns(path, lastTurnId)` (and `buildKiroTurns(input, state)`) returns an object `{ status, turns, userRecords }`
(`status` is `"ok"`, `"missing"` or `"unreadable"`), not an array. `kiro.capture()` unpacks
`turns` before calling the plan builder (`buildIncrementalCapturePlan` iterates its first
argument), logs a non-`ok` status to the debug log, and writes nothing when there is nothing
new. Release 0.1.0 passed the whole object, so every Stop threw `turns is not iterable` inside
`hook.mjs`, which swallows errors by design; nothing was captured. `tests/kiro-capture.test.mjs`
and `tests/kiro-capture-e2e.test.mjs` now run the real capture flow, in process and through
`scripts/hook.mjs`, against a stub server.

## 4. Session-directory discovery, with `sess_`-prefix tolerance

ZCode's rollout path is deterministic. Kiro nests each session under an **opaque parent**:
`~/.kiro/sessions/<shortId>/<sessId>/messages.jsonl`. The locator resolves it by **glob**
(scan `sessions/*/` for a child whose id matches) with a **`session-index/<shortId>.jsonl`**
fallback, and never reuses Kiro's own `publish.cursor` (our cursor is `lastTurnId` in
hook-state).

The session-dir segment is **build-dependent**: a bare UUID on some builds and `sess_<uuid>`
on others — **both occur live**. Kiro's hook stdin carries a `sess_<uuid>` value (VERIFIED),
but stdin and the on-disk dir can still disagree across builds. So the locator strips a leading
`sess_` from **both sides** before comparing, tolerating either shape. Session-id delivery is
**VERIFIED**: stdin `session_id:"sess_<uuid>"` on UserPromptSubmit/Stop, plus env
`KIRO_SESSION_ID` equal to the same value on every hook process; `normalizeInput` reconciles
env → `session_id` before `resolveNativeSessionId`. The cwd-derived degraded mode exists only
as a theoretical last resort and will not trigger in practice.

## 5. Reuse-by-import of the shared runtime

The Kiro host adds only the Kiro-specific surface: the adapter (`hosts/kiro.mjs`), a
`messages.jsonl` turns parser (`hosts/kiro-turns.mjs`), a session locator
(`hosts/kiro-session.mjs`), a user-record classifier (`hosts/kiro-user-records.mjs`), a step-session
detector (`hosts/kiro-session-kind.mjs`), the ask-envelope guard helper (`hosts/kiro-guard.mjs`), a thin
capture wrapper (`hosts/kiro-capture.mjs`), host config templates, the installer/uninstaller,
steering + skill assets, docs, and offline tests. Everything else — `addAgentMessages`,
`commitAgentSession`, the incremental cursor/dedup model, retry queue, MCP proxy, credentials —
is imported from the already-installed shared runtime and **not reimplemented**.

Four files are byte-identical copies of upstream's `examples/agent-hook-plugin/`:
`scripts/hook.mjs`, `scripts/request-budget.mjs`, `servers/mcp-proxy.mjs` and
`hosts/incremental-turn-capture.mjs` (the last lives under the framework's `hosts/`, not under
`memory-plugin-shared/lib`). Six more files are adapted copies and eight follow an upstream
pattern; `upstream.lock.json` records the upstream commit and blob each was taken from or last
reviewed against, and `scripts/check-upstream.mjs` reports drift and verifies the symbols imported
from the shared runtime (see "Keeping in sync with upstream" in the README). If upstream later
moves `incremental-turn-capture.mjs` into the shared lib, the Kiro import switches and the
vendored copy is dropped.

## 6. Capture filtering: injected `user` records and workflow step sessions

**Problem.** In `messages.jsonl`, `payload.type === "user"` is not always the human. Kiro's
workflow engine queues its own events as `user` records with `source: "steer"` and delivers
them to the orchestrating session, and re-delivers some as synthetic user messages. 0.1.1 sent
all of them as user speech, and glued them onto the next real prompt. Every workflow step is
also a separate Kiro session, so user-level hooks fired there and each step became a cloud session.

**Evidence** (full scan of the author's 77 local sessions, 282 `user` and 927 `assistant/Say`
records, no sampling; offline, read-only):

| Group | Records | Harness meta |
|---|---|---|
| `source:"steer"` | 127 | all have `_meta.kiro.notification` (119: 92 JSON-RPC `_kiro/workflow/*`, 27 plain-text step reports) or `steeringClearedIds` (8, empty text) |
| synthetic, no `source` | 15 | `_meta.kiro.syntheticUserMessageReason` (`steering-injection`: `[WORKFLOW NOTIFICATION]`; `agent-initiated-prompt`: `A workflow you launched (...)`) |
| human-looking | 109 | none of the above; 66 have `userMessageTag`, so it is not a usable positive marker |

No human-typed `steer` record exists in the corpus, and every human prompt arrived while no turn
was open. Whether a message typed mid-turn is tagged `steer` is unverified. Largest human message
2,186 characters; largest injected record 88,717. Assistant `Say` records contain no injection.

**User-record rules** (`classifyKiroUserRecord`, `hosts/kiro-user-records.mjs`, applied before a
record can become the pending user text; on the corpus 0 of 109 human prompts are dropped):

1. `_meta.kiro.syntheticUserMessageReason` present: drop.
2. `source === "steer"` and (`_meta.kiro.notification` or `steeringClearedIds` present, or empty
   text): drop. A steer record with none of these is kept, because it may be a human message typed
   mid-turn; losing human input is the worse error.
3. Text backstop for builds that omit the meta keys, anchored at the start of the text: a JSON
   object whose `method` starts with `_kiro/`, or `[WORKFLOW NOTIFICATION]`, `<notification `,
   `A workflow you launched (`: drop. It adds nothing on the corpus (rules 1 and 2 already cover it).
4. Size backstop: more than 12,000 characters and the trimmed text starts with `{`, `[` or `<`: drop.
   The shared `captureMaxLength` truncates at 24,000 instead of dropping, so without this an
   88,717-character event would still send 24,000 characters.
5. Everything else is kept, including records of older builds with no `source` or `_meta`.

Assistant-only turns are captured on purpose: when the user part of a turn was entirely dropped
(for example the agent's answer after a workflow finished), the assistant's `Say` text is still its
reply to the human. Dedup keys are per role (`<turnId>:assistant`), so nothing is sent twice. The
parser reports `userRecords: { kept, dropped: { reason: count } }`; `kiro.capture()` writes it to the
debug log as counts only.

**Step sessions** (`hosts/kiro-session-kind.mjs`). A step session's own `session.json`, which sits
next to its `messages.jsonl`, has `rootConversationId` (a non-empty string), `_meta.kiro.workflow`
and `_meta.kiro.serverSession`; human sessions have none of them. Each key alone separated 31 step
from 41 human sessions with precision 1.000 and recall 1.000 (the 5 empty stub sessions had none).
`workflowsEnabled` and `memoryConfig.mode` are unusable, because orchestrator sessions carry them.
Any one key marks a step session, and `capture()` then returns before reading the transcript:
nothing is read, sent or committed, and one debug line is written.

**Failure asymmetry.** There are three outcomes. A valid `session.json` with no marker is a human
session and is captured, so an older build or a renamed marker never silently drops a human
session. A `session.json` that is missing, unreadable or not a JSON object is "unknown": this Stop
is skipped without writing state, the cursor does not advance and the next Stop retries (the
transcript is re-read each time, so nothing is lost). Fail-open here would let step sessions
pollute memory when Kiro is mid-write. The cost of the unknown case is delayed capture only.

Recall hooks (session start, prompt submit) still run in step sessions. The measurement did not
show harm, and whether the step markers already exist when those hooks fire was not verified.
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
- only `user` contributes user text.

`user` records carry **no** `executionId`, so a pending user message is attached to the next
execution purely by **ordering** (the Kimi Code pattern, not ZCode) and does **not** depend on
`_meta.kiro.userMessageTag`, which is present only in newer builds. If a Stop fires before any
assistant `Say`, the trailing user is **left pending** (no synthetic turn) and captured on the
next Stop under its real `executionId` — this avoids a double-send that a synthetic,
per-record id would cause. Capture is **inline** under a `requestBudgets:{stop:25_000}` budget
that aborts ~5 s before Kiro's 30 s Stop kill, so the cursor state always persists inside the
timeout; an aborted write is enqueued and replayed on the next SessionStart.

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
(`hosts/kiro-session.mjs`), the ask-envelope guard helper (`hosts/kiro-guard.mjs`), a thin
capture wrapper (`hosts/kiro-capture.mjs`), host config templates, the installer/uninstaller,
steering + skill assets, docs, and offline tests. Everything else — `addAgentMessages`,
`commitAgentSession`, the incremental cursor/dedup model, retry queue, MCP proxy, credentials —
is imported from the already-installed shared runtime and **not reimplemented**. The one
byte-identical vendored file is `incremental-turn-capture.mjs` (it lives under the framework's
`hosts/`, not under `memory-plugin-shared/lib`); if upstream later moves it into the shared lib,
the Kiro import switches and the vendored copy is dropped.

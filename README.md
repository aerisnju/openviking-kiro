# OpenViking Memory for Kiro

Long-term semantic memory for the [Kiro](https://kiro.dev) IDE agent, powered by
[OpenViking](https://github.com/volcengine/OpenViking). This is a **thin host**
on OpenViking's `agent-hook-plugin` framework — the same dispatcher and memory
runtime that Cursor, TRAE and ZCode use. Recall relevant memories automatically
and capture the conversation as it happens.

> **Status / disclaimer.** This is an unofficial community integration. It is
> not affiliated with or endorsed by Volcengine, the OpenViking maintainers or
> Kiro. It was verified against the Kiro build available at authoring time;
> Kiro's hook and session formats may change in later builds. Live end-to-end
> behavior depends on a configured OpenViking server (see the OpenViking
> [docs](https://docs.openviking.ai)) and on restarting Kiro after install.
> The automated tests are offline and do not contact any server.

> **Requires the OpenViking shared runtime already installed** at
> `~/.openviking/agent-integrations/memory-plugin-shared/lib`. This package
> reuses that closure by import and never creates it. Install or repair another
> OpenViking memory plugin first if it is missing; the installer preflight
> checks for it and stops with guidance if it is absent.

## What the hooks do

Four user-level Kiro hooks are installed into `~/.kiro/hooks/`:

- **Session start** — injects the user profile and preferences, plus an
  `<available-skills>` catalog, and replays anything an offline session queued.
- **Prompt submit** — searches OpenViking for memories and skills relevant to
  the prompt and injects them as an `<openviking-context>` block, deduplicated
  by event id and a 500 ms window.
- **Pre-tool-use (URI guard)** — when a Kiro read-family file tool
  (`read_file`, `read_code`, `list_directory`, `file_search`, `grep_search`) is
  handed a `viking://` virtual path, surfaces a permission prompt
  (`permissionDecision:"ask"`) steering back to the OpenViking MCP tools. It is
  advisory — Kiro supports `ask`, not `deny` — and never guards shell tools.
- **Stop (capture)** — reads the on-disk `messages.jsonl` for the session,
  parses the new turns since the last cursor, sends them to OpenViking, and
  commits the session. Fails closed: nothing is written when there are no new
  turns.

An `openviking` stdio MCP server (the shared `mcp-proxy.mjs`) is also merged
into `~/.kiro/settings/mcp.json` so the agent can query OpenViking directly.

## Install

```powershell
node scripts/install.mjs
```

Options:

- `--with-steering --with-skill` — also copy the steering file into
  `~/.kiro/steering/` and the `openviking-memory` skill into `~/.kiro/skills/`.
- `--dry-run` — run the preflight and print every file it *would* write.
- `--prefix <dir>` — redirect **both** the `~/.kiro` and `~/.openviking` roots
  under a throwaway dir (used by the offline tests and for safe trials).
- `--verify` — re-read and parse each written hook file and assert its v1 shape
  (defense-in-depth, not a gate).
- `--yes` — accept the optional steering/skill install non-interactively.

Restart Kiro after installing so it picks up the new hooks and MCP server.

**Credentials.** This package ships and asks for none. The hooks use the
endpoint and API key that your OpenViking CLI/runtime is already configured
with (`~/.openviking/ovcli.conf`); the installer does not copy or modify them. Configure
OpenViking by following its own docs, keep that file out of version control,
and do not paste real keys into this repository, its issues, or pull requests.

## Uninstall

```powershell
node scripts/uninstall.mjs
```

Removes only what the installer added — the four `openviking-*.json` hooks it
owns and the `openviking` MCP entry (only if ours) — leaving other hooks, other
MCP servers, credentials (`ovcli.conf`), the shared runtime, and Kiro's native
memory config untouched. Options: `--remove-steering` (delete the steering file
and skill), `--purge-bundle` (remove the copied
`~/.openviking/agent-integrations/kiro/` tree), `--prefix <dir>`.

## Layout

`scripts/hook.mjs` is the single entry every hook command runs; it owns the
state machine (debounce, prompt dedup, recall cache, cross-process lock) shared
by every host and asks the adapter under `hosts/` for the four things that
differ: the event vocabulary, the response envelope, how a prompt is read out
of the payload, and how a finished turn is captured. `scripts/uri-guard.mjs`
and `servers/mcp-proxy.mjs` are likewise one file each, selecting the host from
the client id (`kiro`).

- `hosts/kiro.mjs` — the adapter (mirrors the ZCode host).
- `hosts/kiro-turns.mjs` — parses `messages.jsonl` into ordered turns.
- `hosts/kiro-session.mjs` — locates the session's `messages.jsonl`.
- `hosts/kiro-user-records.mjs` — tells human `user` records from Kiro-injected ones.
- `hosts/kiro-session-kind.mjs` — tells human sessions from workflow step sessions.
- `hosts/kiro-guard.mjs` — the ask-not-deny PreToolUse envelope helper.
- `hosts/kiro-capture.mjs` — thin wrapper over the incremental capture model.
- `scripts/hook.mjs`, `scripts/request-budget.mjs`, `servers/mcp-proxy.mjs` and
  `hosts/incremental-turn-capture.mjs` — byte-identical copies of the upstream
  files (see [NOTICE](./NOTICE) and `upstream.lock.json`).
The memory logic itself is not here: recall, batching, the pending queue,
credential resolution and the MCP proxy all come from
`~/.openviking/agent-integrations/memory-plugin-shared/lib`, imported via the
`../../memory-plugin-shared/lib` relative path that resolves once the bundle is
installed beside the shared closure. See [DESIGN.md](./DESIGN.md) for why the
Kiro host differs from ZCode.

## Coexistence with Kiro native memory

This integration is independent of Kiro's built-in memory. The installer does
not read or modify Kiro's native `memoryConfig`, and the two operate side by
side.

## License and attribution

This project is licensed under the GNU Affero General Public License v3.0 (see
[LICENSE](./LICENSE)). It is built on
[OpenViking](https://github.com/volcengine/OpenViking)'s `agent-hook-plugin`
framework. The upstream code it copies comes from OpenViking's `examples/`
tree, which upstream licenses under Apache-2.0 (the OpenViking repository root
is AGPL-3.0). [NOTICE](./NOTICE) lists which files come from upstream, under
which license, and from which upstream commit.

## Tests

All tests are offline. They use fixtures, temp directories and a stub HTTP
server on `127.0.0.1`; none contacts an OpenViking server or any other remote
host, and none writes outside its temp directory.

```powershell
npm test
```

`npm test` first runs `scripts/check-test-prereqs.mjs`, then
`node --test "tests/**/*.test.mjs"` (the quoted glob is the form that works on
Node 24).

**One-time prerequisite.** The host modules import the shared runtime with the
relative path `../../memory-plugin-shared/lib`, which from a checkout is a
sibling of the repo folder. A fresh clone does not have it, so create it once,
as a link to the runtime that an official OpenViking memory plugin installs
(install one first if `~/.openviking/agent-integrations/memory-plugin-shared`
does not exist):

```powershell
# Windows (PowerShell)
New-Item -ItemType Junction -Path "<repo-parent>\memory-plugin-shared" `
  -Target "$env:USERPROFILE\.openviking\agent-integrations\memory-plugin-shared"
```

```sh
# macOS / Linux
ln -s ~/.openviking/agent-integrations/memory-plugin-shared <repo-parent>/memory-plugin-shared
```

`<repo-parent>` is the folder that contains this repository's folder. If the
link is missing, `npm test` stops at the prerequisite check and prints these
commands with your actual paths. The tests only read through the link. See
[tests/README.md](./tests/README.md) for what each test file covers.

## Keeping in sync with upstream

Four files here are byte-identical copies of upstream files, six are adapted
copies and eight follow an upstream pattern; the shared runtime is imported at
run time. OpenViking changes often, so `upstream.lock.json` records the
upstream commit and blob each file came from (or was last reviewed against),
and `scripts/check-upstream.mjs` compares them with a local clone of
`volcengine/OpenViking`. It has no dependencies and needs only Node 18+ and
`git`.

1. Update your clone yourself, for example `git -C <clone> pull --ff-only`.
   The tool never fetches, pulls, checks out or writes anything in the clone.
2. Check:

   ```sh
   node scripts/check-upstream.mjs --upstream <clone>
   # or: npm run check-upstream -- --upstream <clone>   (or set OPENVIKING_UPSTREAM)
   ```

   Add `--installed <dir>` if your runtime is not under
   `~/.openviking/agent-integrations`, and `--json` for a machine-readable
   report.
3. Read the result:
   - **Class A** (verbatim copies): `IDENTICAL`, or `DRIFTED` with the upstream
     commits since the recorded one. Drift makes the exit code 1.
   - **Class B / C** (adapted or pattern-mirrored files): `UNCHANGED`, or
     `CHANGED` with the upstream commit subjects. This is a warning (exit 0;
     `--strict` makes it exit 1). It means a human should look.
   - **Imports**: the tool parses every import from
     `../../memory-plugin-shared/lib/*` in this repo and checks that each
     symbol still exists in the clone's lib and in the installed lib. Anything
     `MISSING`, `MODULE-MISSING` or `MODULE-ERROR` is `BREAKING` (exit 1).
   - It also prints the upstream HEAD and plugin version, whether the installed
     lib differs from the clone's lib (version skew), and whether upstream now
     mentions Kiro.
   - Exit codes: 0 clean, 1 drift or breakage, 2 usage or I/O error.
4. Class A drift: `node scripts/check-upstream.mjs --upstream <clone> --sync`
   re-copies only the drifted class A files from the clone's working tree
   (LF line endings, exact bytes) and updates their lock entries. It refuses if
   the clone's working tree is dirty for those paths unless you pass `--force`.
   If the new `hook.mjs` imports a sibling file this repo does not have yet, the
   check reports it; add the file to `upstream.lock.json` as class A and run
   `--sync` again.
5. Class B / C changes: read each upstream commit
   (`git -C <clone> show <sha> -- <upstream path>`), port what matters by hand
   (the Kiro-specific differences are listed in [NOTICE](./NOTICE)), then record
   that you reviewed it: `node scripts/check-upstream.mjs --upstream <clone> --update-lock`.
   That command refuses while a class A file is not identical.
6. Run `npm test` (it includes a contract test that fails if upstream's
   dispatcher starts reading an adapter field the Kiro adapter lacks), then
   `node scripts/install.mjs --dry-run`, then install for real and restart
   Kiro.

`upstream.lock.json` is also checked by a test: it fails if a locked file
changed without the lock being updated.

## Known limitations

- **The shared runtime belongs to the official OpenViking installers.** This
  integration imports `~/.openviking/agent-integrations/memory-plugin-shared`
  but does not own it. In OpenViking's `examples/memory-plugin-shared/install.sh`
  (upstream commit `14fa24dc5`), `uninstall_agent_integrations` (lines 2786-2794)
  runs `rm -rf` on that directory when none of the `cursor`, `trae`, `trae-cn`,
  `trae-cli`, `zcode`, `kimicode` or `codebuddy` directories remains under
  `agent-integrations/`; the removal of the legacy TRAE CLI integration (lines
  2377-2383) does the same with the first five. `kiro` is not in those lists.
  So uninstalling your last official hook host deletes the runtime this
  integration imports, and the Kiro hooks then fail until you re-run an official
  installer to restore it. `node scripts/check-upstream.mjs` reports a missing
  installed lib.
- **`plugin.kiro` in `ovcli.conf`** may be reported as an unknown key by the
  official doctor, because `kiro` is not in upstream's `HARNESS_KEYS`. It has
  no functional effect on the hooks; per-harness defaults fall back to the
  global default.
- **What is captured:** user prompts typed by the human and the assistant's
  visible text (`Say` records) only. Tool calls and results, reasoning, and
  sub-agent records are not captured. Records that Kiro injects as `user`
  messages (workflow `steer` events, `_kiro/workflow/*` JSON-RPC,
  `[WORKFLOW NOTIFICATION]` and `A workflow you launched (...)` messages) are
  dropped, and an oversized (> 12,000 characters) JSON/tag-wrapped record is
  dropped as a backstop. A record that matches none of these rules is kept, so
  an unrecognised new shape may still be captured. The agent's reply to such an
  injected message is captured.
- **Workflow/sub-agent step sessions are not captured.** Each workflow step is
  its own Kiro session, and only the human-facing session is written to
  OpenViking. A session counts as a step session when its `session.json` has a
  non-empty `rootConversationId`, or `_meta.kiro.workflow`, or
  `_meta.kiro.serverSession`. Recall (session start, prompt submit) still runs
  in step sessions; only capture is suppressed. If `session.json` is missing or
  unreadable, that Stop skips capture without moving the cursor and the next Stop
  retries; a session whose `session.json` is valid but has none of the markers is
  treated as human and captured. The marker keys are specific to Kiro builds with
  workflow support; a build that renames them would be captured as human.
- **Seeing what was dropped or skipped:** set `OPENVIKING_DEBUG=1` (and
  optionally `OPENVIKING_DEBUG_LOG=<file>`) in the environment Kiro runs the
  hooks with. The Stop hook then writes one JSON line per event:
  `capture_user_records_dropped` (kept and dropped counts per reason),
  `capture_skipped_step_session` and `capture_deferred_session_kind_unknown`
  (reason and session id). Message content is never logged.
- **Earlier data is not cleaned up.** Messages and step sessions captured by
  0.1.1 stay in OpenViking until you delete them.
- **Stop runs inline** under a 25 s request budget (the hook timeout is 30 s).
  A write that does not finish is queued and replayed at the next session start.
- **Verified only on the author's Kiro build.** Kiro's hook and session
  formats may differ in other builds. Release 0.1.0 captured nothing because of
  a bug fixed in 0.1.1, and 0.1.1 captured Kiro-injected messages and workflow
  step sessions, fixed in 0.1.2 (see [CHANGELOG.md](./CHANGELOG.md)).

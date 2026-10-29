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
- `hosts/kiro-guard.mjs` — the ask-not-deny PreToolUse envelope helper.
- `hosts/kiro-capture.mjs` — thin wrapper over the incremental capture model.
- `hosts/incremental-turn-capture.mjs` — vendored byte-identical from the
  framework at upstream commit `03391bae` (the cursor/dedup model); see
  [NOTICE](./NOTICE).

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

Licensed under the GNU Affero General Public License v3.0 (see
[LICENSE](./LICENSE)). This project is derived from and built on
[OpenViking](https://github.com/volcengine/OpenViking)'s `agent-hook-plugin`
framework (`examples/agent-hook-plugin/`, AGPL-3.0), which is also AGPL-3.0.
[NOTICE](./NOTICE) lists which files come from upstream. Source for the
upstream project is at the link above.

## Tests

All tests are offline — they parse fixtures, check envelopes, and write only
into a temp `--prefix` dir. None contact the OpenViking cloud.

```powershell
node --test tests/
```

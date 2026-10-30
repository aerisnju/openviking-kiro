import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { makeTmp } from "./helpers/tmp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const REPO_PARENT = join(REPO, "..");

// The real shared uri-guard.mjs is pure (fs + path + url only, no network), so
// re-exporting from it keeps the test offline while giving the guard its real
// behavior. Prefer the installed copy; fall back to the dev sibling checkout.
function locateSharedUriGuard() {
  const candidates = [
    join(homedir(), ".openviking", "agent-integrations", "memory-plugin-shared", "lib", "uri-guard.mjs"),
    join(REPO_PARENT, "memory-plugin-shared", "lib", "uri-guard.mjs"),
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

// Stage a temp bundle whose <tmp>/kiro/scripts/uri-guard.mjs resolves its
// ../../memory-plugin-shared/lib sibling to our stub, exactly like the install
// layout. Returns the staged uri-guard.mjs path, or null if no shared lib.
function stageBundle() {
  const shared = locateSharedUriGuard();
  if (!shared) return null;

  const tmp = makeTmp("uriguard");
  cpSync(join(REPO, "scripts"), join(tmp, "kiro", "scripts"), { recursive: true });
  cpSync(join(REPO, "hosts"), join(tmp, "kiro", "hosts"), { recursive: true });

  const lib = join(tmp, "memory-plugin-shared", "lib");
  mkdirSync(lib, { recursive: true });

  // uri-guard.mjs guard path needs REAL behavior — re-export from the pure
  // installed/sibling shared file.
  const sharedUrl = pathToFileURL(shared).href;
  writeFileSync(
    join(lib, "uri-guard.mjs"),
    `export { runUriGuardHook, evaluateUriGuard, readToolEvent } from ${JSON.stringify(sharedUrl)};\n`,
  );
  // The other two are only imported for their named bindings by the kiro.mjs
  // closure; the guard path never calls them. Inert no-op exports.
  writeFileSync(
    join(lib, "agent-hook-runtime.mjs"),
    "export const addAgentMessages = async () => ({});\n" +
      "export const commitAgentSession = async () => ({ ok: true });\n" +
      "export const stableHash = () => \"\";\n",
  );
  writeFileSync(
    join(lib, "capture-utils.mjs"),
    "export const sanitizeCapturedText = (s) => s;\n" +
      "export const shouldCaptureText = () => false;\n",
  );

  return join(tmp, "kiro", "scripts", "uri-guard.mjs");
}

function runGuard(scriptPath, argv, payload) {
  return spawnSync(process.execPath, [scriptPath, ...argv], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}

const VIKING_PAYLOAD = {
  tool_name: "read_file",
  tool_input: { path: "viking://user/default/memories" },
};

test("uri-guard entrypoint: `pre-tool-use kiro` emits an ask envelope for a viking:// read", (t) => {
  const scriptPath = stageBundle();
  if (!scriptPath) {
    t.skip("no shared memory-plugin-shared/lib/uri-guard.mjs (installed or sibling) available offline");
    return;
  }

  const r = runGuard(scriptPath, ["pre-tool-use", "kiro"], VIKING_PAYLOAD);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.trim(), "guard must print a JSON line");
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /OpenViking MCP/);
});

test("uri-guard entrypoint: the client id is read from argv[3], not argv[2] (the fix)", (t) => {
  // This pins the fix, not the environment. The old code read clientId from
  // argv[2]; the corrected code reads argv[3]. Drive the guard with a GARBAGE
  // value in argv[2] (the event slot) and the real "kiro" in argv[3]:
  //   - Under the OLD bug, clientId = argv[2] = "GARBAGE-EVENT", HOSTS[...] is
  //     undefined, HOSTS[clientId].guard throws → exit 1, no ask envelope.
  //   - Under the FIX, clientId = argv[3] = "kiro" → the guard fires and emits
  //     the ask envelope regardless of what argv[2] holds.
  // So a passing assertion here can only hold once argv[3] is the slot read.
  const scriptPath = stageBundle();
  if (!scriptPath) {
    t.skip("no shared memory-plugin-shared/lib/uri-guard.mjs (installed or sibling) available offline");
    return;
  }

  const r = runGuard(scriptPath, ["GARBAGE-EVENT", "kiro"], VIKING_PAYLOAD);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
});

test("uri-guard entrypoint: a normal local path is no-opinion (empty stdout, exit 0)", (t) => {
  const scriptPath = stageBundle();
  if (!scriptPath) {
    t.skip("no shared memory-plugin-shared/lib/uri-guard.mjs (installed or sibling) available offline");
    return;
  }

  const r = runGuard(scriptPath, ["pre-tool-use", "kiro"], {
    tool_name: "read_file",
    tool_input: { path: "src/main.ts" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "", "no viking:// path → {} → nothing printed");
});

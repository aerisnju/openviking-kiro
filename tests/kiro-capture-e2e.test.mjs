/**
 * Process-level end-to-end test of the Stop hook, through the real entry point.
 *
 * What runs for real: scripts/install.mjs (into a temp --prefix, so the layout
 * is the one users get), then `node <bundle>/scripts/hook.mjs stop kiro` as a
 * subprocess with the hook JSON on stdin; hook.mjs -> the Kiro adapter -> the
 * copied official shared runtime (read from the sibling checkout, copied into
 * the temp tree) -> real fetch() against a stub OpenViking server that this
 * test starts on 127.0.0.1.
 *
 * What is stubbed: only the server. Its URL comes from a temp ovcli.conf. The
 * subprocess environment is built from an allow-list (no inherited OPENVIKING_*
 * variables), HOME / USERPROFILE / KIRO_HOME and every OpenViking state path
 * point into the temp tree, and the only network peer is the loopback stub.
 *
 * What is NOT covered: Kiro itself (how it invokes hooks, what it puts on
 * stdin), the real OpenViking server's behavior, and shell quoting of the
 * rendered hook command (the script path is taken from the rendered file and
 * executed directly with node).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

import { fixInstructions, findSharedLib } from "../scripts/check-test-prereqs.mjs";
import { makeTmp } from "./helpers/tmp.mjs";
import {
  STEP_SESSION_JSON,
  append,
  exchange,
  jsonRpcEvent,
  newSessionId,
  say,
  seedSession,
  steerEvent,
  syntheticUser,
  turnStart,
  userOnly,
  writeSessionJson,
} from "./helpers/kiro-session-fixture.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_VERSION = JSON.parse(readFileSync(join(REPO, "plugin.json"), "utf8")).version;

const Q1 = "How do I rotate the signing keys for the staging cluster?";
const A1 = "Run the rotation job from the ops console, then restart the signer pods one at a time.";
const Q2 = "And what do I check afterwards to be sure nothing broke?";
const A2 = "Verify the health endpoint reports the new key id and watch the error rate for ten minutes.";

let root;
let home;
let kiroHome;
let stateDir;
let logFile;
let hookScript;
let server;
let requests;
let sessionId;
let messagesPath;

function startStub() {
  requests = [];
  server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", result: {} }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

/** Environment for the hook subprocess: an allow-list, nothing inherited from OPENVIKING_*. */
function isolatedEnv() {
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    TEMP: join(root, "tmp"),
    TMP: join(root, "tmp"),
    TMPDIR: join(root, "tmp"),
    KIRO_HOME: kiroHome,
    OPENVIKING_DEBUG: "1",
    OPENVIKING_DEBUG_LOG: logFile,
    OPENVIKING_CLI_CONFIG_FILE: join(home, ".openviking", "ovcli.conf"),
    OPENVIKING_HOOK_STATE_DIR: stateDir,
    OPENVIKING_PENDING_DIR: join(home, ".openviking", "pending"),
  };
  for (const name of ["SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "PATHEXT"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

function runHook(stdinObject) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookScript, "stop", "kiro"], {
      cwd: join(root, "workspace"),
      env: isolatedEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(stdinObject));
  });
}

const stopInput = (sid = sessionId) => ({ session_id: sid, hook_event_name: "Stop", cwd: join(root, "workspace") });
const batchRequests = () => requests.filter((r) => /\/messages\/batch$/.test(r.url));
const commitRequests = () => requests.filter((r) => /\/commit$/.test(r.url));
const logLines = () =>
  existsSync(logFile)
    ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

before(async () => {
  const sharedLib = findSharedLib();
  assert.ok(sharedLib, `shared runtime sibling missing\n${fixInstructions()}`);

  root = makeTmp("e2e");
  home = join(root, "home");
  kiroHome = join(home, ".kiro");
  stateDir = join(home, ".openviking", "hook-state");
  logFile = join(home, ".openviking", "logs", "kiro-hooks.log");
  for (const dir of [join(root, "tmp"), join(root, "workspace"), join(home, ".openviking")]) {
    mkdirSync(dir, { recursive: true });
  }

  // Copy (read-only) the official shared runtime into the temp agent-integrations
  // layout, then run the REAL installer into the same temp prefix.
  const integrations = join(home, ".openviking", "agent-integrations");
  cpSync(realpathSync(dirname(sharedLib)), join(integrations, "memory-plugin-shared"), { recursive: true });
  const install = spawnSync(process.execPath, [join(REPO, "scripts", "install.mjs"), "--prefix", home], {
    encoding: "utf8",
    env: { ...isolatedEnv() },
  });
  assert.equal(install.status, 0, install.stderr);

  const rendered = JSON.parse(readFileSync(join(kiroHome, "hooks", "openviking-stop.json"), "utf8"));
  const command = rendered.hooks[0].action.command;
  const match = /^node "(.+)" stop kiro$/.exec(command);
  assert.ok(match, `unexpected stop hook command: ${command}`);
  hookScript = match[1];
  assert.ok(hookScript.startsWith(integrations), "hook runs from the temp bundle");

  const port = await startStub();
  writeFileSync(
    join(home, ".openviking", "ovcli.conf"),
    JSON.stringify({ url: `http://127.0.0.1:${port}` }),
  );

  sessionId = newSessionId();
  messagesPath = seedSession(kiroHome, sessionId);
  append(messagesPath, exchange("exec-1", Q1, A1));
});

after(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
});

test("Stop through hook.mjs: posts the turns, commits, persists state, logs no uncaught error", async () => {
  const run = await runHook(stopInput());

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "", "Stop writes no envelope");

  assert.equal(batchRequests().length, 1, "one messages/batch POST");
  const batch = batchRequests()[0];
  assert.equal(batch.method, "POST");
  assert.match(batch.url, new RegExp(`^/api/v1/sessions/ki-${sessionId}/messages/batch$`));
  assert.deepEqual(batch.body.messages, [
    { role: "user", content: Q1, turn_id: "exec-1" },
    { role: "assistant", content: A1, turn_id: "exec-1" },
  ]);
  assert.equal(commitRequests().length, 1, "one commit");
  assert.equal(
    requests.indexOf(commitRequests()[0]) > requests.indexOf(batch),
    true,
    "commit after messages",
  );
  assert.equal(
    batch.headers["user-agent"],
    `openviking-memory-kiro/${PLUGIN_VERSION}`,
    "integration version reaches the User-Agent",
  );

  const stateFile = join(stateDir, "kiro", `${sessionId}.json`);
  assert.ok(existsSync(stateFile), "hook state written");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(state.lastTurnId, "exec-1");
  assert.deepEqual([...state.capturedTurnIds].sort(), ["exec-1:assistant", "exec-1:user"]);
  assert.equal(state.capturedSinceCommit, 0);

  // Isolation: the runtime's own bookkeeping landed in the temp home, not the real one.
  const runtimeState = join(home, ".openviking", "state");
  assert.ok(existsSync(runtimeState), "workspace-identity cache written under the temp home");

  const lines = logLines();
  assert.ok(lines.length > 0, "debug log is active (so 'no uncaught' is meaningful)");
  assert.ok(lines.some((l) => l.stage === "commit"), "commit logged");
  assert.deepEqual(
    lines.filter((l) => l.stage === "uncaught"),
    [],
    "no uncaught error swallowed by hook.mjs",
  );
});

test("a second Stop with nothing new makes no request", async () => {
  const before = requests.length;
  const run = await runHook(stopInput());
  assert.equal(run.status, 0, run.stderr);
  assert.equal(requests.length, before);
  assert.deepEqual(logLines().filter((l) => l.stage === "uncaught"), []);
});

test("a new turn is sent alone on the next Stop", async () => {
  append(messagesPath, exchange("exec-2", Q2, A2));
  const run = await runHook(stopInput());
  assert.equal(run.status, 0, run.stderr);
  assert.equal(batchRequests().length, 2);
  assert.deepEqual(batchRequests()[1].body.messages, [
    { role: "user", content: Q2, turn_id: "exec-2" },
    { role: "assistant", content: A2, turn_id: "exec-2" },
  ]);
  assert.equal(commitRequests().length, 2);
  assert.deepEqual(logLines().filter((l) => l.stage === "uncaught"), []);
});

test("a session with harness-injected records: only the human text is POSTed, drop counts are logged", async () => {
  const sid = newSessionId();
  const path = seedSession(kiroHome, sid, { shortId: "orch01" });
  append(
    path,
    userOnly("h1", Q1) +
      turnStart("exec-1") +
      say("exec-1", A1) +
      steerEvent("s1", jsonRpcEvent("_kiro/workflow/run_start", { d: "SYNTH-RUNSTART" })) +
      steerEvent("s2", "SYNTH-STEP-REPORT", { notification: { kind: "system-notification" } }) +
      syntheticUser("n1", "[WORKFLOW NOTIFICATION] SYNTH-NOTE") +
      turnStart("exec-2") +
      say("exec-2", A2),
  );
  const before = requests.length;

  const run = await runHook(stopInput(sid));

  assert.equal(run.status, 0, run.stderr);
  const mine = requests.slice(before);
  const batches = mine.filter((r) => /\/messages\/batch$/.test(r.url));
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].body.messages, [
    { role: "user", content: Q1, turn_id: "exec-1" },
    { role: "assistant", content: A1, turn_id: "exec-1" },
    { role: "assistant", content: A2, turn_id: "exec-2" }, // assistant-only turn is kept on purpose
  ]);
  assert.equal(JSON.stringify(mine.map((r) => r.body)).includes("SYNTH-"), false);
  assert.equal(JSON.stringify(mine.map((r) => r.body)).includes("_kiro/"), false);

  const dropLine = logLines().find((l) => l.stage === "capture_user_records_dropped" && l.data?.session_id === `ki-${sid}`);
  assert.ok(dropLine, "debug log has the drop counts");
  assert.equal(dropLine.data.kept, 1);
  assert.deepEqual(dropLine.data.dropped, { steer_notification: 2, synthetic_user_message: 1 });
  assert.equal(readFileSync(logFile, "utf8").includes("SYNTH-"), false, "log never has dropped content");
  assert.deepEqual(logLines().filter((l) => l.stage === "uncaught"), []);
});

test("a workflow step session: the Stop hook makes no request at all, logs the skip once; a human session still captures", async () => {
  const stepId = newSessionId();
  const stepPath = seedSession(kiroHome, stepId, { shortId: "step01", sessionJson: STEP_SESSION_JSON });
  append(stepPath, exchange("exec-s1", Q1, A1));
  const before = requests.length;

  const run1 = await runHook(stopInput(stepId));
  const run2 = await runHook(stopInput(stepId));
  assert.equal(run1.status, 0, run1.stderr);
  assert.equal(run2.status, 0, run2.stderr);
  assert.equal(requests.length, before, "no request for a step session");

  const skips = logLines().filter((l) => l.stage === "capture_skipped_step_session" && l.data?.session_id === `ki-${stepId}`);
  assert.equal(skips.length, 1, "skip logged once across two Stops");
  assert.equal(skips[0].data.reason, "root_conversation_id");

  // the human session next to it still captures
  const humanId = newSessionId();
  const humanPath = seedSession(kiroHome, humanId, { shortId: "human01" });
  append(humanPath, exchange("exec-h1", Q2, A2));
  const run3 = await runHook(stopInput(humanId));
  assert.equal(run3.status, 0, run3.stderr);
  const posted = requests.slice(before).filter((r) => /\/messages\/batch$/.test(r.url));
  assert.equal(posted.length, 1);
  assert.match(posted[0].url, new RegExp(`/sessions/ki-${humanId}/messages/batch$`));
  assert.deepEqual(logLines().filter((l) => l.stage === "uncaught"), []);
});

test("unreadable session.json: nothing is sent, the cursor is not advanced, and a later Stop captures once", async () => {
  const sid = newSessionId();
  const path = seedSession(kiroHome, sid, { shortId: "late01", sessionJson: "{ broken" });
  append(path, exchange("exec-l1", Q1, A1));
  const before = requests.length;

  const run1 = await runHook(stopInput(sid));
  assert.equal(run1.status, 0, run1.stderr);
  assert.equal(requests.length, before);
  assert.equal(existsSync(join(stateDir, "kiro", `${sid}.json`)), false, "no hook state written");
  const deferred = logLines().find((l) => l.stage === "capture_deferred_session_kind_unknown" && l.data?.session_id === `ki-${sid}`);
  assert.equal(deferred?.data?.reason, "session_json_invalid");

  writeSessionJson(path, { title: "Synthetic" });
  const run2 = await runHook(stopInput(sid));
  assert.equal(run2.status, 0, run2.stderr);
  const run3 = await runHook(stopInput(sid));
  assert.equal(run3.status, 0, run3.stderr);
  const posted = requests.slice(before).filter((r) => /\/messages\/batch$/.test(r.url));
  assert.equal(posted.length, 1, "captured exactly once");
  assert.deepEqual(posted[0].body.messages.map((m) => m.role), ["user", "assistant"]);
});

test("every request went to the loopback stub (nothing else was contacted)", () => {
  assert.ok(requests.length >= 4);
  for (const r of requests) assert.match(r.headers.host, /^127\.0\.0\.1:\d+$/);
});

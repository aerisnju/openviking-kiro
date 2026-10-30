/**
 * Unit-level end-to-end tests of kiro.capture(): the adapter's real capture
 * flow (session locator -> transcript parser -> plan -> addAgentMessages ->
 * commitAgentSession -> state) with only the HTTP layer stubbed.
 *
 * These exist because 0.1.0 passed buildKiroTurns()'s `{status, turns}` object
 * to the plan builder, which iterates its first argument; capture() threw
 * "turns is not iterable" on every Stop and the old suite never called it.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, beforeEach } from "node:test";

import { kiro } from "../hosts/kiro.mjs";
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

const Q1 = "How do I rotate the signing keys for the staging cluster?";
const A1 = "Run the rotation job from the ops console, then restart the signer pods one at a time.";
const Q2 = "And what do I check afterwards to be sure nothing broke?";
const A2 = "Verify the health endpoint reports the new key id and watch the error rate for ten minutes.";
const Q3 = "Please also write down the rollback procedure for the same operation.";
const A3 = "Rollback means restoring the previous key secret and restarting the signer pods again.";

// Never let a failed send park anything in the real ~/.openviking/pending, and
// point Kiro at a throwaway home.
const saved = {};
function setEnv(name, value) {
  if (!(name in saved)) saved[name] = process.env[name];
  process.env[name] = value;
}
function restoreEnv() {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
}
after(restoreEnv);

let kiroHome;
let sessionId;
let messagesPath;
beforeEach(() => {
  restoreEnv();
  const root = makeTmp("capture");
  kiroHome = join(root, ".kiro");
  setEnv("KIRO_HOME", kiroHome);
  setEnv("OPENVIKING_PENDING_DIR", join(root, "pending"));
  sessionId = newSessionId();
  messagesPath = seedSession(kiroHome, sessionId);
});

/** A fetchJSON stub that records every call and answers ok (or a chosen failure). */
function stubFetch(respond = () => ({ ok: true, status: 200, result: {} })) {
  const calls = [];
  const fetchJSON = async (path, init = {}) => {
    calls.push({ path, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    return respond(path, init);
  };
  return { fetchJSON, calls };
}

function makeCtx(fetchJSON, extra = {}) {
  const logs = [];
  return {
    ctx: {
      cfg: {},
      input: { session_id: sessionId, hook_event_name: "Stop" },
      sessionId: `ki-${sessionId}`,
      peerId: "",
      fetchJSON,
      log: (event, data) => logs.push([event, data]),
      logError: () => {},
      ...extra,
    },
    logs,
  };
}

const batches = (calls) => calls.filter((c) => c.path.endsWith("/messages/batch"));
const commits = (calls) => calls.filter((c) => c.path.endsWith("/commit"));
const sentMessages = (calls) => batches(calls).flatMap((c) => c.body.messages);

test("capture() does not throw and posts user + assistant turns, then commits", async () => {
  append(messagesPath, exchange("exec-1", Q1, A1) + exchange("exec-2", Q2, A2));
  const { fetchJSON, calls } = stubFetch();
  const { ctx } = makeCtx(fetchJSON);

  const next = await kiro.capture(ctx, {}, "stop");

  assert.ok(next, "capture returns a state");
  assert.equal(batches(calls).length, 1, "one batch POST");
  assert.match(batches(calls)[0].path, new RegExp(`^/api/v1/sessions/ki-${sessionId}/messages/batch$`));
  assert.deepEqual(sentMessages(calls), [
    { role: "user", content: Q1, turn_id: "exec-1" },
    { role: "assistant", content: A1, turn_id: "exec-1" },
    { role: "user", content: Q2, turn_id: "exec-2" },
    { role: "assistant", content: A2, turn_id: "exec-2" },
  ]);
  assert.equal(commits(calls).length, 1, "one commit after a successful capture");
  assert.ok(
    calls.findIndex((c) => c.path.endsWith("/commit")) > calls.findIndex((c) => c.path.endsWith("/messages/batch")),
    "commit comes after the messages",
  );

  assert.equal(next.lastTurnId, "exec-2");
  assert.deepEqual(
    [...next.capturedTurnIds].sort(),
    ["exec-1:assistant", "exec-1:user", "exec-2:assistant", "exec-2:user"],
  );
  assert.equal(next.capturedSinceCommit, 0, "reset after an ok commit");
  assert.equal("captured" in next, false, "transient `captured` count is not persisted");
  assert.equal("__log" in next, false, "locator logger is not persisted");
});

test("capture() sends only private-reasoning-free assistant text (Say only)", async () => {
  append(messagesPath, exchange("exec-1", Q1, A1));
  const { fetchJSON, calls } = stubFetch();
  await kiro.capture(makeCtx(fetchJSON).ctx, {}, "stop");
  const text = JSON.stringify(sentMessages(calls));
  assert.equal(text.includes("private reasoning"), false);
  assert.equal(text.includes("read_file"), false);
});

test("a second Stop with no new records sends nothing and returns null", async () => {
  append(messagesPath, exchange("exec-1", Q1, A1));
  const { fetchJSON, calls } = stubFetch();
  const { ctx } = makeCtx(fetchJSON);
  const state1 = await kiro.capture(ctx, {}, "stop");
  const before = calls.length;

  const again = await kiro.capture(ctx, state1, "stop");

  assert.equal(again, null, "no-op: caller writes no state");
  assert.equal(calls.length, before, "no network call");
});

test("a new turn appended afterwards sends only the new turn", async () => {
  append(messagesPath, exchange("exec-1", Q1, A1));
  const { fetchJSON, calls } = stubFetch();
  const { ctx } = makeCtx(fetchJSON);
  const state1 = await kiro.capture(ctx, {}, "stop");
  calls.length = 0;

  append(messagesPath, exchange("exec-2", Q2, A2));
  const state2 = await kiro.capture(ctx, state1, "stop");

  assert.deepEqual(sentMessages(calls), [
    { role: "user", content: Q2, turn_id: "exec-2" },
    { role: "assistant", content: A2, turn_id: "exec-2" },
  ]);
  assert.equal(commits(calls).length, 1);
  assert.equal(state2.lastTurnId, "exec-2");
  assert.equal(state2.capturedTurnIds.length, 4);

  // and a third exchange after that, again only the delta
  calls.length = 0;
  append(messagesPath, exchange("exec-3", Q3, A3));
  const state3 = await kiro.capture(ctx, state2, "stop");
  assert.deepEqual(sentMessages(calls).map((m) => m.turn_id), ["exec-3", "exec-3"]);
  assert.equal(state3.lastTurnId, "exec-3");
});

test("Stop before the assistant answers: user text is sent exactly once, under the real executionId", async () => {
  append(messagesPath, userOnly("u-1", Q1));
  const { fetchJSON, calls } = stubFetch();
  const { ctx } = makeCtx(fetchJSON);

  const first = await kiro.capture(ctx, {}, "stop");
  assert.equal(first, null, "dangling user: nothing to send, no state change");
  assert.equal(calls.length, 0);

  append(messagesPath, turnStart("exec-9") + say("exec-9", A1));
  const second = await kiro.capture(ctx, {}, "stop");
  assert.ok(second);
  const users = sentMessages(calls).filter((m) => m.role === "user");
  assert.equal(users.length, 1, "user captured once");
  assert.equal(users[0].turn_id, "exec-9");
  assert.equal(users[0].content, Q1);

  // a further Stop must not resend it
  calls.length = 0;
  assert.equal(await kiro.capture(ctx, second, "stop"), null);
  assert.equal(calls.length, 0);
});

test("a failed (non-retryable) send advances nothing and does not commit", async () => {
  append(messagesPath, exchange("exec-1", Q1, A1));
  const { fetchJSON, calls } = stubFetch(() => ({ ok: false, status: 400, result: null, error: { message: "bad" } }));
  const { ctx } = makeCtx(fetchJSON);

  const next = await kiro.capture(ctx, {}, "stop");

  assert.equal(commits(calls).length, 0, "no commit when nothing was captured");
  assert.deepEqual(next.capturedTurnIds, []);
  assert.equal(next.lastTurnId ?? null, null, "cursor does not advance past unsent turns");
  assert.equal(next.capturedSinceCommit, 0);
});

test("a failed commit leaves capturedSinceCommit counting the captured messages", async () => {
  append(messagesPath, exchange("exec-1", Q1, A1));
  const { fetchJSON } = stubFetch((path) =>
    path.endsWith("/commit")
      ? { ok: false, status: 400, result: null, error: { message: "no" } }
      : { ok: true, status: 200, result: {} },
  );
  const next = await kiro.capture(makeCtx(fetchJSON).ctx, {}, "stop");
  assert.equal(next.capturedSinceCommit, 2);
  assert.equal(next.lastTurnId, "exec-1");
});

test("unresolved session id: no network, logged once, loggedUnresolved persisted", async () => {
  const { fetchJSON, calls } = stubFetch();
  const { ctx, logs } = makeCtx(fetchJSON, {
    input: { session_id: "sess_00000000-0000-4000-8000-00000000dead" },
  });

  const first = await kiro.capture(ctx, {}, "stop");
  assert.equal(calls.length, 0);
  assert.equal(first.loggedUnresolved, true, "flag persisted");
  assert.ok(logs.some(([event]) => event === "warn"), "locator warned");
  assert.ok(logs.some(([event]) => event === "capture_missing"), "status logged");

  logs.length = 0;
  const second = await kiro.capture(ctx, first, "stop");
  assert.equal(second, null, "already flagged: nothing more to persist");
  assert.equal(logs.some(([event]) => event === "warn"), false, "warn fires once per session");
  assert.equal(calls.length, 0);
});

test("regression guard: capture() unpacks buildKiroTurns()'s {status, turns} before planning", () => {
  const src = readFileSync(join(REPO, "hosts", "kiro.mjs"), "utf8");
  assert.equal(
    /buildKiroCapturePlan\(\s*buildKiroTurns\(/.test(src),
    false,
    "must not pass buildKiroTurns()'s result object straight to buildKiroCapturePlan",
  );
  const unpacked =
    /const\s*\{[^}]*\bturns\b[^}]*\}\s*=\s*buildKiroTurns\(/.test(src) ||
    /buildKiroCapturePlan\(\s*\w+\.turns\b/.test(src);
  assert.ok(unpacked, "the turns array must be unpacked from the builder result");
});

// ── Injected records never reach the POST body ───────────────────────────────

test("capture(): steer events, notifications and synthetic messages never reach the POST body; counts are logged", async () => {
  append(
    messagesPath,
    userOnly("h1", Q1) +
      turnStart("exec-1") +
      say("exec-1", A1) +
      steerEvent("s1", jsonRpcEvent("_kiro/workflow/run_start", { d: "SYNTH-RUNSTART" })) +
      steerEvent("s2", "SYNTH-STEP-REPORT", { notification: { kind: "system-notification" } }) +
      steerEvent("s3", "", { steeringClearedIds: ["s1"] }) +
      syntheticUser("n1", "[WORKFLOW NOTIFICATION] SYNTH-NOTE") +
      userOnly("h2", Q2) +
      turnStart("exec-2") +
      say("exec-2", A2),
  );
  const { fetchJSON, calls } = stubFetch();
  const { ctx, logs } = makeCtx(fetchJSON);

  const next = await kiro.capture(ctx, {}, "stop");

  assert.deepEqual(sentMessages(calls), [
    { role: "user", content: Q1, turn_id: "exec-1" },
    { role: "assistant", content: A1, turn_id: "exec-1" },
    { role: "user", content: Q2, turn_id: "exec-2" },
    { role: "assistant", content: A2, turn_id: "exec-2" },
  ]);
  const body = JSON.stringify(calls.map((c) => c.body));
  for (const marker of ["SYNTH-", "_kiro/", "WORKFLOW NOTIFICATION"]) assert.equal(body.includes(marker), false, marker);
  assert.equal(next.lastTurnId, "exec-2");

  const dropLog = logs.find(([event]) => event === "capture_user_records_dropped");
  assert.ok(dropLog, "drop counts are logged");
  assert.deepEqual(dropLog[1].dropped, { steer_notification: 2, steer_cleared: 1, synthetic_user_message: 1 });
  assert.equal(dropLog[1].kept, 2);
  assert.equal(JSON.stringify(logs).includes("SYNTH-"), false, "logs carry counts and reasons, never content");
});

test("capture(): an assistant-only turn (user part fully injected) is captured once, alongside a later normal turn", async () => {
  append(
    messagesPath,
    exchange("exec-1", Q1, A1) +
      syntheticUser("n1", "[WORKFLOW NOTIFICATION] the workflow finished") +
      turnStart("exec-2") +
      say("exec-2", A2),
  );
  const { fetchJSON, calls } = stubFetch();
  const { ctx } = makeCtx(fetchJSON);

  const first = await kiro.capture(ctx, {}, "stop");
  assert.deepEqual(sentMessages(calls).map((m) => `${m.turn_id}:${m.role}`), [
    "exec-1:user",
    "exec-1:assistant",
    "exec-2:assistant",
  ]);
  assert.equal(first.lastTurnId, "exec-2");

  calls.length = 0;
  append(messagesPath, exchange("exec-3", Q3, A3));
  await kiro.capture(ctx, first, "stop");
  assert.deepEqual(sentMessages(calls).map((m) => `${m.turn_id}:${m.role}`), ["exec-3:user", "exec-3:assistant"]);
});

test("capture(): Stop-before-assistant with an injected record ahead of the human prompt: user sent once under the real executionId", async () => {
  append(messagesPath, steerEvent("s0", jsonRpcEvent("_kiro/workflow/node_start")) + userOnly("h1", Q1));
  const { fetchJSON, calls } = stubFetch();
  const { ctx } = makeCtx(fetchJSON);
  assert.equal(await kiro.capture(ctx, {}, "stop"), null, "only a dangling human user: nothing to send");
  append(messagesPath, turnStart("exec-5") + say("exec-5", A1));
  const second = await kiro.capture(ctx, {}, "stop");
  assert.deepEqual(sentMessages(calls), [
    { role: "user", content: Q1, turn_id: "exec-5" },
    { role: "assistant", content: A1, turn_id: "exec-5" },
  ]);
  calls.length = 0;
  assert.equal(await kiro.capture(ctx, second, "stop"), null);
  assert.equal(calls.length, 0);
});

// ── Workflow / sub-agent step sessions are not captured ──────────────────────

test("step session: capture() reads, sends and commits NOTHING, and logs the reason once", async () => {
  writeSessionJson(messagesPath, STEP_SESSION_JSON);
  // If anything read the transcript it would log capture_unreadable (a directory is not readable as a file).
  rmSync(messagesPath);
  mkdirSync(messagesPath);
  const { fetchJSON, calls } = stubFetch();
  const { ctx, logs } = makeCtx(fetchJSON);

  const first = await kiro.capture(ctx, {}, "stop");
  assert.equal(calls.length, 0, "no request of any kind");
  assert.equal(first.loggedStepSession, true);
  assert.deepEqual(Object.keys(first).sort(), ["loggedStepSession"], "no capture cursor/state advanced");
  const skip = logs.filter(([event]) => event === "capture_skipped_step_session");
  assert.equal(skip.length, 1);
  assert.deepEqual(skip[0][1], { reason: "root_conversation_id", session_id: `ki-${sessionId}` });
  assert.equal(logs.some(([event]) => event.startsWith("capture_unreadable")), false, "transcript was never read");

  logs.length = 0;
  assert.equal(await kiro.capture(ctx, first, "stop"), null, "second Stop: silent no-op");
  assert.equal(logs.length, 0, "logged only once");
  assert.equal(calls.length, 0);
});

test("step session with injected-looking records still sends nothing; a human session beside it still captures", async () => {
  append(messagesPath, exchange("exec-1", Q1, A1));
  writeSessionJson(messagesPath, STEP_SESSION_JSON);
  const stepStub = stubFetch();
  await kiro.capture(makeCtx(stepStub.fetchJSON).ctx, {}, "stop");
  assert.equal(stepStub.calls.length, 0);

  // a second, human-facing session in the same Kiro home
  const humanId = newSessionId();
  const humanPath = seedSession(kiroHome, humanId, { shortId: "def456" });
  append(humanPath, exchange("exec-h1", Q2, A2));
  const humanStub = stubFetch();
  const { ctx } = makeCtx(humanStub.fetchJSON, {
    input: { session_id: humanId, hook_event_name: "Stop" },
    sessionId: `ki-${humanId}`,
  });
  const next = await kiro.capture(ctx, {}, "stop");
  assert.deepEqual(sentMessages(humanStub.calls), [
    { role: "user", content: Q2, turn_id: "exec-h1" },
    { role: "assistant", content: A2, turn_id: "exec-h1" },
  ]);
  assert.equal(commits(humanStub.calls).length, 1);
  assert.equal(next.lastTurnId, "exec-h1");
});

test("session.json missing: this Stop is skipped without advancing the cursor, logged with reason + session id only", async () => {
  append(messagesPath, exchange("exec-1", Q1, A1));
  writeSessionJson(messagesPath, null);
  const { fetchJSON, calls } = stubFetch();
  const { ctx, logs } = makeCtx(fetchJSON);

  assert.equal(await kiro.capture(ctx, {}, "stop"), null, "no state written, cursor untouched");
  assert.equal(calls.length, 0);
  const deferred = logs.filter(([event]) => event === "capture_deferred_session_kind_unknown");
  assert.equal(deferred.length, 1);
  assert.deepEqual(deferred[0][1], { reason: "session_json_missing", session_id: `ki-${sessionId}` });
});

test("session.json unreadable first, readable later: captured then, exactly once", async () => {
  append(messagesPath, exchange("exec-1", Q1, A1));
  writeSessionJson(messagesPath, "{ half-written");
  const { fetchJSON, calls } = stubFetch();
  const { ctx, logs } = makeCtx(fetchJSON);

  assert.equal(await kiro.capture(ctx, {}, "stop"), null);
  assert.equal(calls.length, 0);
  assert.equal(
    logs.find(([event]) => event === "capture_deferred_session_kind_unknown")[1].reason,
    "session_json_invalid",
  );

  // Kiro finishes writing session.json (a human session): the next Stop captures.
  writeSessionJson(messagesPath, { title: "Synthetic" });
  const second = await kiro.capture(ctx, {}, "stop");
  assert.deepEqual(sentMessages(calls), [
    { role: "user", content: Q1, turn_id: "exec-1" },
    { role: "assistant", content: A1, turn_id: "exec-1" },
  ]);
  assert.equal(second.lastTurnId, "exec-1");

  // and not again
  calls.length = 0;
  assert.equal(await kiro.capture(ctx, second, "stop"), null);
  assert.equal(calls.length, 0);
});

test("session.json unreadable, then it turns out to be a step session: still nothing is ever sent", async () => {
  append(messagesPath, exchange("exec-1", Q1, A1));
  writeSessionJson(messagesPath, "");
  const { fetchJSON, calls } = stubFetch();
  const { ctx } = makeCtx(fetchJSON);
  assert.equal(await kiro.capture(ctx, {}, "stop"), null);
  writeSessionJson(messagesPath, STEP_SESSION_JSON);
  await kiro.capture(ctx, {}, "stop");
  assert.equal(calls.length, 0);
});

test("an older human session.json without any step marker is captured", async () => {
  append(messagesPath, exchange("exec-1", Q1, A1));
  writeSessionJson(messagesPath, { sessionId, title: "old build", workflowsEnabled: true, memoryConfig: { mode: "read_write" } });
  const { fetchJSON, calls } = stubFetch();
  await kiro.capture(makeCtx(fetchJSON).ctx, {}, "stop");
  assert.equal(sentMessages(calls).length, 2);
});
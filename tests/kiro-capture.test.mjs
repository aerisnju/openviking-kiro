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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, beforeEach } from "node:test";

import { kiro } from "../hosts/kiro.mjs";
import { makeTmp } from "./helpers/tmp.mjs";
import {
  append,
  exchange,
  newSessionId,
  say,
  seedSession,
  turnStart,
  userOnly,
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

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { makeTmp } from "./helpers/tmp.mjs";

import {
  buildKiroTurns,
  cleanKiroText,
  extractUnseenKiroTurns,
} from "../hosts/kiro-turns.mjs";
import { buildKiroCapturePlan, applyKiroCaptureResult } from "../hosts/kiro-capture.mjs";
import {
  exchange,
  jsonRpcEvent,
  say,
  steerEvent,
  syntheticUser,
  turnStart,
  userOnly,
  userRecord,
} from "./helpers/kiro-session-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "messages.sample.jsonl");

const writeLines = (path, records) =>
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

test("allow-list parse: user attaches to next executionId, Say concatenated, everything else dropped", () => {
  const { status, turns } = extractUnseenKiroTurns(fixture);
  assert.equal(status, "ok");
  assert.deepEqual(turns, [
    { role: "user", content: "first question", turnId: "exec-1", userMessageTag: "prompt_aaa" },
    { role: "assistant", content: "first answer part one and part two", turnId: "exec-1" },
    { role: "user", content: "second question", turnId: "exec-2" },
    { role: "assistant", content: "second answer", turnId: "exec-2" },
  ]);
});

test("cleanKiroText strips injected context blocks and trims", () => {
  assert.equal(
    cleanKiroText("<openviking-context>old</openviking-context>keep this"),
    "keep this",
  );
  assert.equal(
    cleanKiroText([
      { type: "text", text: "hello" },
      { type: "text", text: "<relevant-memories>x</relevant-memories>world" },
    ]),
    "hello\n world",
  );
  assert.equal(
    cleanKiroText("<system-reminder>note</system-reminder>  actual  "),
    "actual",
  );
});

test("incremental slice: state.lastTurnId=exec-1 returns only exec-2 turns", () => {
  const { turns } = extractUnseenKiroTurns(fixture, "exec-1");
  assert.deepEqual(turns, [
    { role: "user", content: "second question", turnId: "exec-2" },
    { role: "assistant", content: "second answer", turnId: "exec-2" },
  ]);
});

test("duplicate Stop: after acknowledging all turns, a second plan sends nothing", () => {
  const { turns } = extractUnseenKiroTurns(fixture);
  const plan1 = buildKiroCapturePlan(turns, {}, {});
  assert.ok(plan1.toSend.length > 0);
  const state2 = applyKiroCaptureResult({}, plan1, { sent: plan1.toSend.length, queued: 0 });
  // Re-parse from the stored cursor and re-plan → nothing new.
  const { turns: turns2 } = extractUnseenKiroTurns(fixture, state2.lastTurnId);
  const plan2 = buildKiroCapturePlan(turns2, state2, {});
  assert.equal(plan2.toSend.length, 0);
});

test("cursor loss: lastTurnId absent from file restarts from head, ack set suppresses dupes", () => {
  const { turns } = extractUnseenKiroTurns(fixture, "rotated-away");
  // Absent cursor → indexOf(-1) → slice(0) → full head.
  assert.equal(turns.length, 4);
  const acked = applyKiroCaptureResult(
    {},
    buildKiroCapturePlan(turns, {}, {}),
    { sent: turns.length, queued: 0 },
  );
  // Same turns re-seen but all dedup keys acknowledged → nothing to send.
  const plan = buildKiroCapturePlan(turns, acked, {});
  assert.equal(plan.toSend.length, 0);
});

test("trailing user with no following execution → no turn (left pending)", () => {
  const dir = makeTmp("turns");
  const path = join(dir, "messages.jsonl");
  writeLines(path, [
    { id: "u1", timestamp: "t", payload: { type: "user", content: "dangling question" } },
  ]);
  assert.deepEqual(extractUnseenKiroTurns(path).turns, []);
});

test("Stop-before-assistant then Stop-after-assistant → exactly ONE user capture under real executionId", () => {
  const dir = makeTmp("turns");
  const path = join(dir, "messages.jsonl");

  // Stop 1: file ends on a pending user with no execution yet.
  writeLines(path, [
    { id: "u1", timestamp: "t1", payload: { type: "user", content: "please investigate the bug" } },
  ]);
  const plan1 = buildKiroCapturePlan(extractUnseenKiroTurns(path, null).turns, {}, {});
  assert.equal(plan1.toSend.length, 0, "no turn synthesized for the dangling user");
  const state1 = applyKiroCaptureResult({}, plan1, { sent: 0, queued: 0 });

  // Stop 2: the assistant execution materializes; the user is captured once.
  writeLines(path, [
    { id: "u1", timestamp: "t1", payload: { type: "user", content: "please investigate the bug" } },
    { id: "ts", timestamp: "t2", payload: { type: "turn_start", executionId: "exec-9" } },
    {
      id: "a1",
      timestamp: "t3",
      payload: { type: "assistant", operationType: "Say", executionId: "exec-9", content: "here is the fix" },
    },
  ]);
  const turns2 = extractUnseenKiroTurns(path, state1.lastTurnId).turns;
  assert.deepEqual(turns2, [
    { role: "user", content: "please investigate the bug", turnId: "exec-9" },
    { role: "assistant", content: "here is the fix", turnId: "exec-9" },
  ]);
  const plan2 = buildKiroCapturePlan(turns2, state1, {});
  const userSends = plan2.payloads.filter((p) => p.role === "user");
  assert.equal(userSends.length, 1, "user captured exactly once");
  assert.equal(userSends[0].turn_id, "exec-9", "under the real executionId, not a per-record id");
});

test("allow-list negative: sub_agent_* carrying an executionId creates no turn", () => {
  const dir = makeTmp("turns");
  const path = join(dir, "messages.jsonl");
  writeLines(path, [
    { id: "s1", timestamp: "t1", payload: { type: "sub_agent_start", executionId: "exec-x" } },
    { id: "s2", timestamp: "t2", payload: { type: "sub_agent_complete", executionId: "exec-x" } },
  ]);
  assert.deepEqual(extractUnseenKiroTurns(path).turns, []);
});

test("a user record without _meta still parses and attaches by ordering", () => {
  const dir = makeTmp("turns");
  const path = join(dir, "messages.jsonl");
  writeLines(path, [
    { id: "u1", timestamp: "t1", payload: { type: "user", content: "no meta here" } },
    { id: "ts", timestamp: "t2", payload: { type: "turn_start", executionId: "exec-7" } },
    {
      id: "a1",
      timestamp: "t3",
      payload: { type: "assistant", operationType: "Say", executionId: "exec-7", content: "ok" },
    },
  ]);
  const { turns } = extractUnseenKiroTurns(path);
  assert.deepEqual(turns, [
    { role: "user", content: "no meta here", turnId: "exec-7" },
    { role: "assistant", content: "ok", turnId: "exec-7" },
  ]);
  assert.equal("userMessageTag" in turns[0], false);
});

test("buildKiroTurns returns no turns and fails closed when the session path is unresolved", () => {
  const prev = process.env.KIRO_HOME;
  process.env.KIRO_HOME = makeTmp("home");
  try {
    const out = buildKiroTurns({ session_id: "sess_missing" }, {});
    assert.deepEqual(out.turns, []);
  } finally {
    if (prev === undefined) delete process.env.KIRO_HOME;
    else process.env.KIRO_HOME = prev;
  }
});

// ── Harness-injected user records (steer / synthetic) ────────────────────────

function mixedFile(parts) {
  const path = join(makeTmp("turns"), "messages.jsonl");
  writeFileSync(path, parts.join(""));
  return path;
}

const HOOK_BLOCK =
  '<HOOK_INSTRUCTION>{"hookSpecificOutput":{"additionalContext":"synthetic hook text"}}</HOOK_INSTRUCTION>';

test("mixed session: only the human text is sent; steer JSON-RPC, notifications and hook blocks are not", () => {
  const path = mixedFile([
    userRecord("h1", "Please run the workflow for the migration."),
    turnStart("exec-1"),
    say("exec-1", "Started the workflow."),
    steerEvent("s1", jsonRpcEvent("_kiro/workflow/run_start", { def: "x".repeat(2000) })),
    steerEvent("s2", jsonRpcEvent("_kiro/workflow/node_complete", { n: 1 })),
    steerEvent("s3", "Plain step report from a sub-agent.", { notification: { kind: "system-notification" } }),
    steerEvent("s4", "", { steeringClearedIds: ["s1", "s2", "s3"] }),
    syntheticUser("n1", '[WORKFLOW NOTIFICATION]\n<notification id="x">step done</notification>'),
    syntheticUser("n2", 'A workflow you launched ("demo") completed.', "agent-initiated-prompt"),
    steerEvent("s5", jsonRpcEvent("_kiro/workflow/run_complete", { quoted: HOOK_BLOCK })),
    userRecord("h2", "Thanks, now summarise it."),
    turnStart("exec-2"),
    say("exec-2", "Here is the summary."),
  ]);
  const { status, turns, userRecords } = extractUnseenKiroTurns(path);
  assert.equal(status, "ok");
  assert.deepEqual(turns, [
    { role: "user", content: "Please run the workflow for the migration.", turnId: "exec-1" },
    { role: "assistant", content: "Started the workflow.", turnId: "exec-1" },
    { role: "user", content: "Thanks, now summarise it.", turnId: "exec-2" },
    { role: "assistant", content: "Here is the summary.", turnId: "exec-2" },
  ]);
  assert.deepEqual(userRecords, {
    kept: 2,
    dropped: { steer_notification: 4, steer_cleared: 1, synthetic_user_message: 2 },
  });
  const sent = JSON.stringify(buildKiroCapturePlan(turns, {}, {}).payloads);
  for (const forbidden of ["_kiro/", "WORKFLOW NOTIFICATION", "Plain step report", "A workflow you launched", "HOOK_INSTRUCTION"]) {
    assert.equal(sent.includes(forbidden), false, forbidden);
  }
});

test("injected records are not glued onto the next human turn", () => {
  const path = mixedFile([
    steerEvent("s1", jsonRpcEvent("_kiro/workflow/run_complete", { r: 1 })),
    syntheticUser("n1", "[WORKFLOW NOTIFICATION] done"),
    userRecord("h1", "My real question."),
    turnStart("exec-1"),
    say("exec-1", "My real answer."),
  ]);
  assert.deepEqual(extractUnseenKiroTurns(path).turns[0], {
    role: "user",
    content: "My real question.",
    turnId: "exec-1",
  });
});

test("huge injected event (~89k chars) never reaches a turn, with and without harness meta", () => {
  const huge = jsonRpcEvent("_kiro/workflow/run_complete", { blob: "z".repeat(89_000) });
  const path = mixedFile([
    steerEvent("s1", huge),
    userRecord("s2", huge), // an old build with the same text but no source/_meta
    userRecord("h1", "short human prompt"),
    turnStart("exec-1"),
    say("exec-1", "ok"),
  ]);
  const { turns, userRecords } = extractUnseenKiroTurns(path);
  assert.deepEqual(turns[0], { role: "user", content: "short human prompt", turnId: "exec-1" });
  assert.deepEqual(userRecords.dropped, { steer_notification: 1, kiro_jsonrpc_event: 1 });
});

test("a long pasted human prompt (above the size backstop, plain text) is kept intact", () => {
  const pasted = "Stack trace:\n" + "at frame.run(file.js:10)\n".repeat(700);
  const path = mixedFile([userRecord("h1", pasted), turnStart("exec-1"), say("exec-1", "looking")]);
  const { turns, userRecords } = extractUnseenKiroTurns(path);
  assert.equal(turns[0].content, pasted.trim());
  assert.deepEqual(userRecords.dropped, {});
});

test("old-build records (source:chat, no source, no _meta) and a steer record without notification meta are all kept", () => {
  const path = mixedFile([
    userRecord("h1", "old chat prompt", { source: "chat" }),
    userRecord("h2", "bare prompt"),
    userRecord("h3", "mid-turn correction typed by the human", { source: "steer" }),
    turnStart("exec-1"),
    say("exec-1", "ok"),
  ]);
  const { turns, userRecords } = extractUnseenKiroTurns(path);
  assert.equal(turns[0].content, "old chat prompt\nbare prompt\nmid-turn correction typed by the human");
  assert.equal(userRecords.kept, 3);
  assert.deepEqual(userRecords.dropped, {});
});

test("assistant-only turn: user part fully injected, assistant Say text is still captured (decision)", () => {
  const path = mixedFile([
    exchange("exec-1", "Run the workflow please.", "Launched it."),
    syntheticUser("n1", "[WORKFLOW NOTIFICATION] the workflow finished"),
    turnStart("exec-2"),
    say("exec-2", "The workflow finished; here is what changed."),
  ]);
  const { turns } = extractUnseenKiroTurns(path);
  assert.deepEqual(turns.filter((t) => t.turnId === "exec-2"), [
    { role: "assistant", content: "The workflow finished; here is what changed.", turnId: "exec-2" },
  ]);

  // Per-role dedup: it is sent once; a later Stop does not resend it, and the
  // already-acknowledged exec-1 turns do not block it.
  const state1 = applyKiroCaptureResult(
    {},
    buildKiroCapturePlan(turns.filter((t) => t.turnId === "exec-1"), {}, {}),
    { sent: 2, queued: 0 },
  );
  const plan = buildKiroCapturePlan(turns, state1, {});
  assert.deepEqual(plan.payloads, [
    { role: "assistant", content: "The workflow finished; here is what changed.", turn_id: "exec-2" },
  ]);
  const state2 = applyKiroCaptureResult(state1, plan, { sent: 1, queued: 0 });
  assert.equal(state2.lastTurnId, "exec-2");
  assert.equal(
    buildKiroCapturePlan(extractUnseenKiroTurns(path, state2.lastTurnId).turns, state2, {}).toSend.length,
    0,
  );
});

test("a turn whose user part was dropped and which has no assistant text yields no turn", () => {
  const path = mixedFile([steerEvent("s1", jsonRpcEvent("_kiro/workflow/node_start")), turnStart("exec-1")]);
  assert.deepEqual(extractUnseenKiroTurns(path).turns, []);
});

test("Stop-before-assistant with injected records pending: only the human user is sent, exactly once, under the real executionId", () => {
  const path = mixedFile([
    exchange("exec-1", "first question here", "first answer here"),
    userRecord("h2", "second question while a workflow runs"),
    steerEvent("s1", jsonRpcEvent("_kiro/workflow/node_complete")),
  ]);
  // Stop 1: trailing human user + trailing injected event, no execution yet
  const turns1 = extractUnseenKiroTurns(path).turns;
  const plan1 = buildKiroCapturePlan(turns1, {}, {});
  assert.deepEqual(plan1.payloads.map((p) => p.turn_id), ["exec-1", "exec-1"]);
  const state1 = applyKiroCaptureResult({}, plan1, { sent: 2, queued: 0 });

  writeFileSync(
    path,
    [
      exchange("exec-1", "first question here", "first answer here"),
      userRecord("h2", "second question while a workflow runs"),
      steerEvent("s1", jsonRpcEvent("_kiro/workflow/node_complete")),
      turnStart("exec-2"),
      say("exec-2", "second answer here"),
    ].join(""),
  );
  const plan2 = buildKiroCapturePlan(extractUnseenKiroTurns(path, state1.lastTurnId).turns, state1, {});
  assert.deepEqual(plan2.payloads, [
    { role: "user", content: "second question while a workflow runs", turn_id: "exec-2" },
    { role: "assistant", content: "second answer here", turn_id: "exec-2" },
  ]);
});

test("a userOnly helper record stays a plain human user record", () => {
  const path = mixedFile([userOnly("u", "plain"), turnStart("exec-1"), say("exec-1", "a")]);
  assert.equal(extractUnseenKiroTurns(path).turns[0].content, "plain");
});
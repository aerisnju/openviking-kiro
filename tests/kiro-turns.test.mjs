import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildKiroTurns,
  cleanKiroText,
  extractUnseenKiroTurns,
} from "../hosts/kiro-turns.mjs";
import { buildKiroCapturePlan, applyKiroCaptureResult } from "../hosts/kiro-capture.mjs";

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
  const dir = mkdtempSync(join(tmpdir(), "ov-kiro-turns-"));
  const path = join(dir, "messages.jsonl");
  writeLines(path, [
    { id: "u1", timestamp: "t", payload: { type: "user", content: "dangling question" } },
  ]);
  assert.deepEqual(extractUnseenKiroTurns(path).turns, []);
});

test("Stop-before-assistant then Stop-after-assistant → exactly ONE user capture under real executionId", () => {
  const dir = mkdtempSync(join(tmpdir(), "ov-kiro-turns-"));
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
  const dir = mkdtempSync(join(tmpdir(), "ov-kiro-turns-"));
  const path = join(dir, "messages.jsonl");
  writeLines(path, [
    { id: "s1", timestamp: "t1", payload: { type: "sub_agent_start", executionId: "exec-x" } },
    { id: "s2", timestamp: "t2", payload: { type: "sub_agent_complete", executionId: "exec-x" } },
  ]);
  assert.deepEqual(extractUnseenKiroTurns(path).turns, []);
});

test("a user record without _meta still parses and attaches by ordering", () => {
  const dir = mkdtempSync(join(tmpdir(), "ov-kiro-turns-"));
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
  process.env.KIRO_HOME = mkdtempSync(join(tmpdir(), "ov-kiro-home-"));
  try {
    const out = buildKiroTurns({ session_id: "sess_missing" }, {});
    assert.deepEqual(out.turns, []);
  } finally {
    if (prev === undefined) delete process.env.KIRO_HOME;
    else process.env.KIRO_HOME = prev;
  }
});

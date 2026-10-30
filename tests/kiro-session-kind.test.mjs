import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { classifyKiroSession, classifySessionJson } from "../hosts/kiro-session-kind.mjs";
import { makeTmp } from "./helpers/tmp.mjs";
import {
  HUMAN_SESSION_JSON,
  STEP_SESSION_JSON,
  newSessionId,
  seedSession,
  writeSessionJson,
} from "./helpers/kiro-session-fixture.mjs";

test("each of the three independent keys marks a step session", () => {
  assert.deepEqual(classifySessionJson({ rootConversationId: "sess_x" }), {
    kind: "step",
    reason: "root_conversation_id",
  });
  assert.deepEqual(classifySessionJson({ _meta: { kiro: { workflow: { workflowId: "w" } } } }), {
    kind: "step",
    reason: "workflow_meta",
  });
  assert.deepEqual(classifySessionJson({ _meta: { kiro: { serverSession: { role: "step" } } } }), {
    kind: "step",
    reason: "server_session_meta",
  });
  assert.equal(classifySessionJson(STEP_SESSION_JSON).kind, "step");
});

test("a valid session.json without markers is human, including orchestrator-like flags", () => {
  assert.deepEqual(classifySessionJson(HUMAN_SESSION_JSON), { kind: "human", reason: "no_step_marker" });
  // workflowsEnabled / memoryConfig are NOT markers: orchestrator sessions carry them
  const orchestrator = { workflowsEnabled: true, memoryConfig: { mode: "read_write" }, backgroundExecution: {} };
  assert.equal(classifySessionJson(orchestrator).kind, "human");
  // empty / wrong-typed marker values do not count
  assert.equal(classifySessionJson({ rootConversationId: "" }).kind, "human");
  assert.equal(classifySessionJson({ rootConversationId: 5 }).kind, "human");
  assert.equal(classifySessionJson({ _meta: { kiro: { workflow: null } } }).kind, "human");
  assert.equal(classifySessionJson({ _meta: { kiro: { workflow: "x" } } }).kind, "human");
});

test("a non-object session.json value is unknown", () => {
  for (const value of [null, [], "text", 7, undefined]) {
    assert.deepEqual(classifySessionJson(value), { kind: "unknown", reason: "session_json_not_object" });
  }
});

test("classifyKiroSession reads session.json next to messages.jsonl", () => {
  const home = makeTmp("kind");
  const human = seedSession(home, newSessionId());
  const step = seedSession(home, newSessionId(), { sessionJson: STEP_SESSION_JSON });
  assert.equal(classifyKiroSession(human).kind, "human");
  assert.equal(classifyKiroSession(step).kind, "step");
});

test("missing, unreadable and invalid session.json are unknown, never human or step", () => {
  const home = makeTmp("kind");
  const path = seedSession(home, newSessionId(), { sessionJson: null });
  assert.deepEqual(classifyKiroSession(path), { kind: "unknown", reason: "session_json_missing" });

  writeSessionJson(path, "{ not json");
  assert.deepEqual(classifyKiroSession(path), { kind: "unknown", reason: "session_json_invalid" });
  writeSessionJson(path, ""); // e.g. observed mid-rewrite
  assert.deepEqual(classifyKiroSession(path), { kind: "unknown", reason: "session_json_invalid" });
  writeSessionJson(path, "[1,2]");
  assert.equal(classifyKiroSession(path).kind, "unknown");

  // a directory where the file should be: read fails with something other than ENOENT
  const dirPath = seedSession(home, newSessionId(), { sessionJson: null });
  mkdirSync(join(dirname(dirPath), "session.json"));
  assert.deepEqual(classifyKiroSession(dirPath), { kind: "unknown", reason: "session_json_unreadable" });

  assert.deepEqual(classifyKiroSession(""), { kind: "unknown", reason: "no_messages_path" });
});


test("results never include session.json content", () => {
  const home = makeTmp("kind");
  const path = seedSession(home, newSessionId(), {
    sessionJson: { ...STEP_SESSION_JSON, title: "SYNTHETIC-TITLE-MARKER" },
  });
  assert.equal(JSON.stringify(classifyKiroSession(path)).includes("SYNTHETIC-TITLE-MARKER"), false);
});

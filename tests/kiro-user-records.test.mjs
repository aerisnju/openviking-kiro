/**
 * classifyKiroUserRecord(): one case per record shape. All text is synthetic;
 * the shapes mirror what a scan of real Kiro transcripts found (see DESIGN.md).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  OVERSIZED_STRUCTURED_CHARS,
  classifyKiroUserRecord,
} from "../hosts/kiro-user-records.mjs";
import { jsonRpcEvent } from "./helpers/kiro-session-fixture.mjs";

const user = (content, extra = {}) => ({ type: "user", content, ...extra });
const verdict = (payload) => classifyKiroUserRecord(payload);

test("human shapes are kept: tagged, caller-client, bare, old `chat` source, no _meta", () => {
  const cases = [
    user("Please summarise yesterday's incident review.", {
      _meta: { kiro: { userMessageTag: "prompt_x" } },
      documents: [],
      images: [],
    }),
    user("hello", { _meta: { kiro: { __callerClientId: "client-x" } } }),
    user("hello bare"),
    user("old build prompt", { source: "chat" }),
    user("no meta at all", { _meta: {} }),
  ];
  for (const payload of cases) assert.deepEqual(verdict(payload), { keep: true, reason: "human" });
});

test("human prompts with multi-line text, non-ASCII, pasted code, documents and images are kept", () => {
  const multi = "Line one\n\nLine two with a list:\n- a\n- b\n";
  const cjk = "请帮我检查这个配置文件，并解释每个字段的含义。";
  const pasted = `Here is the log:\n${"error: something failed\n".repeat(800)}`; // ~19k chars, plain text
  const withAttachments = user("see attached", {
    documents: [{ name: "a.txt" }],
    images: [{ mime: "image/png" }],
    _meta: { kiro: { userMessageTag: "t" } },
  });
  for (const payload of [user(multi), user(cjk), user(pasted), user([{ text: "part one" }, { text: cjk }]), withAttachments]) {
    assert.equal(verdict(payload).keep, true, JSON.stringify(payload).slice(0, 40));
  }
  assert.ok(pasted.length > OVERSIZED_STRUCTURED_CHARS, "fixture really is above the size backstop");
});

test("human text that merely mentions the markers mid-text is kept (rules are start-anchored)", () => {
  assert.equal(verdict(user('Why does my log contain "[WORKFLOW NOTIFICATION]" lines?')).keep, true);
  assert.equal(verdict(user('The event {"method":"_kiro/x"} showed up in the log, what is it?')).keep, true);
  assert.equal(verdict(user("What does <notification> mean in the docs?")).keep, true);
});

test("R2: steer with _meta.kiro.notification is dropped (JSON-RPC and plain-text step report)", () => {
  const rpc = user(jsonRpcEvent("_kiro/workflow/run_start", { x: 1 }), {
    source: "steer",
    _meta: { kiro: { notification: { kind: "workflow-progress" } } },
  });
  const report = user("Implemented the change and ran the tests.", {
    source: "steer",
    _meta: { kiro: { notification: { kind: "system-notification", sender: "step" } } },
  });
  assert.deepEqual(verdict(rpc), { keep: false, reason: "steer_notification" });
  assert.deepEqual(verdict(report), { keep: false, reason: "steer_notification" });
});

test("R2: steer with steeringClearedIds, or with empty text, is dropped", () => {
  assert.deepEqual(
    verdict(user("", { source: "steer", _meta: { kiro: { steeringClearedIds: ["a"] } } })),
    { keep: false, reason: "steer_cleared" },
  );
  assert.deepEqual(verdict(user("  \n", { source: "steer" })), { keep: false, reason: "steer_empty" });
});

test("R2 is narrow: a steer record WITHOUT notification/cleared meta and with text is kept (possible human mid-turn message)", () => {
  assert.deepEqual(verdict(user("wait, use the other branch instead", { source: "steer" })), {
    keep: true,
    reason: "steer_unmarked_kept",
  });
  assert.deepEqual(
    verdict(user("also keep the old API", { source: "steer", _meta: { kiro: { userMessageTag: "t" } } })),
    { keep: true, reason: "steer_unmarked_kept" },
  );
});

test("R3: any syntheticUserMessageReason is dropped, with or without source", () => {
  for (const reason of ["steering-injection", "agent-initiated-prompt", "some-future-reason"]) {
    assert.deepEqual(
      verdict(user("whatever text", { _meta: { kiro: { syntheticUserMessageReason: reason } } })),
      { keep: false, reason: "synthetic_user_message" },
    );
  }
  assert.equal(
    verdict(user("x", { source: "steer", _meta: { kiro: { syntheticUserMessageReason: "r" } } })).reason,
    "synthetic_user_message",
  );
});

test("R4: text envelopes are dropped when the meta keys are absent", () => {
  const cases = {
    notification_envelope: [
      '[WORKFLOW NOTIFICATION]\n\nA workflow step sent...\n<notification id="n1">x</notification>',
      '  <notification id="n1">leading whitespace</notification>',
      'A workflow you launched ("synthetic") completed.',
    ],
    kiro_jsonrpc_event: [
      jsonRpcEvent("_kiro/workflow/node_start"),
      '{"method":"_kiro/workflow/run_complete","params":{}}',
      '{\n  "jsonrpc": "2.0",\n  "method": "_kiro/workflow/steps_queued"\n}',
    ],
  };
  for (const [reason, texts] of Object.entries(cases)) {
    for (const text of texts) assert.deepEqual(verdict(user(text)), { keep: false, reason }, text.slice(0, 30));
  }
  // also when delivered as a content-parts array
  assert.equal(verdict(user([{ text: "[WORKFLOW NOTIFICATION] x" }])).keep, false);
});

test("R5: oversized structured text is dropped; oversized plain text and small structured text are kept", () => {
  const big = (open, close) => `${open}${"x".repeat(OVERSIZED_STRUCTURED_CHARS)}${close}`;
  for (const text of [big("{", "}"), big("[", "]"), big("<tag>", "</tag>"), `  \n${big("{", "}")}`]) {
    assert.deepEqual(verdict(user(text)), { keep: false, reason: "oversized_structured" });
  }
  assert.equal(verdict(user("plain " + "x".repeat(OVERSIZED_STRUCTURED_CHARS))).keep, true);
  assert.equal(verdict(user('{"a": 1, "note": "small pasted json"}')).keep, true);
  const edge = "{" + "x".repeat(OVERSIZED_STRUCTURED_CHARS - 1);
  assert.equal(edge.length, OVERSIZED_STRUCTURED_CHARS);
  assert.equal(verdict(user(edge)).keep, true, "at the threshold (not above) is kept");
});

test("a huge (~89k) run_complete event is dropped by the meta rule and, without meta, by the text rule", () => {
  const huge = jsonRpcEvent("_kiro/workflow/run_complete", { blob: "y".repeat(89_000) });
  assert.equal(verdict(user(huge, { source: "steer", _meta: { kiro: { notification: {} } } })).reason, "steer_notification");
  assert.equal(verdict(user(huge)).reason, "kiro_jsonrpc_event");
});

test("non-user and malformed payloads are not classified as dropped", () => {
  assert.deepEqual(verdict({ type: "assistant", operationType: "Say", content: "x" }), {
    keep: true,
    reason: "not_a_user_record",
  });
  assert.equal(verdict(null).keep, true);
  assert.equal(verdict("str").keep, true);
  assert.equal(verdict(user(undefined)).keep, true);
});

test("the verdict never carries record content", () => {
  const secret = "SYNTHETIC-CONTENT-MARKER";
  const v = verdict(user(`[WORKFLOW NOTIFICATION] ${secret}`));
  assert.equal(JSON.stringify(v).includes(secret), false);
});

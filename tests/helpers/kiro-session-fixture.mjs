/**
 * Builders for a throwaway Kiro home with one session transcript, used by the
 * capture tests. Layout matches what hosts/kiro-session.mjs resolves:
 *   <kiroHome>/sessions/<shortId>/<sess_uuid>/messages.jsonl
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

let counter = 0;

export function newSessionId() {
  counter += 1;
  const n = String(counter).padStart(12, "0");
  return `sess_aaaaaaaa-bbbb-4ccc-8ddd-${n}`;
}

/**
 * Create the session dir with an empty messages.jsonl and a session.json.
 * `sessionJson`: an object (serialized), a string (written raw, e.g. broken
 * JSON), or null (no session.json at all). The default is a human-facing
 * session. Returns the messages.jsonl path.
 */
export function seedSession(kiroHome, sessionId, { shortId = "abc123", sessionJson = HUMAN_SESSION_JSON } = {}) {
  const dir = join(kiroHome, "sessions", shortId, sessionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "messages.jsonl");
  writeFileSync(path, "");
  writeSessionJson(path, sessionJson);
  return path;
}

/** (Re)write, or remove with null, the session.json next to a messages.jsonl. */
export function writeSessionJson(messagesPath, sessionJson) {
  const file = join(dirname(messagesPath), "session.json");
  if (sessionJson === null) {
    rmSync(file, { force: true });
    return;
  }
  writeFileSync(file, typeof sessionJson === "string" ? sessionJson : JSON.stringify(sessionJson));
}

/** Synthetic shapes only; the ids are fake. */
export const HUMAN_SESSION_JSON = { title: "Synthetic human session", agentMode: "vibe" };
export const STEP_SESSION_JSON = {
  title: "synthetic-flow \u00b7 step-one",
  agentMode: "wf-coder",
  rootConversationId: "sess_00000000-0000-4000-8000-000000000001",
  _meta: {
    kiro: {
      workflow: { workflowId: "wf_synthetic", nodeId: "n1" },
      serverSession: { role: "step", ownerSessionId: "sess_00000000-0000-4000-8000-000000000001" },
    },
  },
};

const rec = (id, payload) => JSON.stringify({ id, timestamp: "2026-03-05T10:00:00.000Z", payload }) + "\n";

/** One complete exchange: user, turn_start, reasoning/tool noise, Say, turn_end. */
export function exchange(execId, user, say) {
  return [
    rec(`u-${execId}`, { type: "user", content: user }),
    rec(`ts-${execId}`, { type: "turn_start", executionId: execId }),
    rec(`r-${execId}`, { type: "assistant", operationType: "Reasoning", executionId: execId, content: "private reasoning" }),
    rec(`tc-${execId}`, { type: "tool_call", executionId: execId, name: "read_file" }),
    rec(`a-${execId}`, { type: "assistant", operationType: "Say", executionId: execId, content: say }),
    rec(`te-${execId}`, { type: "turn_end", executionId: execId }),
  ].join("");
}

export const userOnly = (id, text) => rec(id, { type: "user", content: text });
export const turnStart = (execId) => rec(`ts-${execId}`, { type: "turn_start", executionId: execId });
export const say = (execId, text) =>
  rec(`a-${execId}`, { type: "assistant", operationType: "Say", executionId: execId, content: text });

/** A raw user record with arbitrary payload fields (source, _meta, ...). */
export const userRecord = (id, content, extra = {}) => rec(id, { type: "user", content, ...extra });

/** Synthetic stand-ins for what the Kiro harness injects (shape only, fake text). */
export const steerEvent = (id, text, kiroMeta = { notification: { kind: "workflow-progress", workflowId: "wf_synthetic" } }) =>
  rec(id, { type: "user", source: "steer", content: text, _meta: { kiro: kiroMeta } });
export const syntheticUser = (id, text, reason = "steering-injection") =>
  rec(id, { type: "user", content: text, _meta: { kiro: { syntheticUserMessageReason: reason } } });
export const jsonRpcEvent = (method, params = {}) =>
  JSON.stringify({ jsonrpc: "2.0", method, params });

export function append(path, text) {
  appendFileSync(path, text);
}

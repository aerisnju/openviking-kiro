/**
 * Builders for a throwaway Kiro home with one session transcript, used by the
 * capture tests. Layout matches what hosts/kiro-session.mjs resolves:
 *   <kiroHome>/sessions/<shortId>/<sess_uuid>/messages.jsonl
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let counter = 0;

export function newSessionId() {
  counter += 1;
  const n = String(counter).padStart(12, "0");
  return `sess_aaaaaaaa-bbbb-4ccc-8ddd-${n}`;
}

export function seedSession(kiroHome, sessionId, { shortId = "abc123" } = {}) {
  const dir = join(kiroHome, "sessions", shortId, sessionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "messages.jsonl");
  writeFileSync(path, "");
  return path;
}

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

export function append(path, text) {
  appendFileSync(path, text);
}

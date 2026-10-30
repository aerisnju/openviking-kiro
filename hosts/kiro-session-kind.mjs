/**
 * Tell a human-facing Kiro session from a workflow/sub-agent STEP session.
 *
 * Every workflow step runs as its own Kiro session and user-level hooks fire
 * there too, so without this each step becomes a separate low-value cloud
 * session. Policy: capture only the human-facing (orchestrator) sessions.
 *
 * Marker: the step session's own `session.json`, which sits next to its
 * messages.jsonl (so the existing locator already finds it). Any ONE of three
 * independent keys marks a step session:
 *   - rootConversationId      non-empty string (id of the orchestrating session)
 *   - _meta.kiro.workflow     object
 *   - _meta.kiro.serverSession object
 * Measured on 77 real sessions (31 step, 41 human, 5 empty stubs): each key
 * alone is precision 1.000 / recall 1.000. `workflowsEnabled` and
 * `memoryConfig.mode` are NOT usable (orchestrator sessions carry them too).
 *
 * Result kinds, and what the caller does with them:
 *   "step"    -> skip this Stop's capture entirely (reads/sends/commits nothing).
 *   "human"   -> capture as usual (also the result when session.json is valid
 *                but has none of the markers, e.g. any build that predates
 *                workflows: a missing MARKER means human, never "skip").
 *   "unknown" -> session.json is missing, unreadable or not a JSON object. The
 *                caller skips THIS Stop without advancing the cursor, so the
 *                next Stop retries. Rationale: fail-open would let step
 *                sessions pollute memory; fail-closed with the cursor kept only
 *                delays capture of a human session until the file is readable.
 *                Nothing is lost, because the transcript is re-read each Stop.
 *
 * Reasons are short constants; session.json content is never returned.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Pure: classify an already-parsed session.json value. */
export function classifySessionJson(sessionJson) {
  if (!isObject(sessionJson)) return { kind: "unknown", reason: "session_json_not_object" };
  if (typeof sessionJson.rootConversationId === "string" && sessionJson.rootConversationId.trim()) {
    return { kind: "step", reason: "root_conversation_id" };
  }
  const kiroMeta = sessionJson._meta?.kiro;
  if (isObject(kiroMeta?.workflow)) return { kind: "step", reason: "workflow_meta" };
  if (isObject(kiroMeta?.serverSession)) return { kind: "step", reason: "server_session_meta" };
  return { kind: "human", reason: "no_step_marker" };
}

/**
 * Read `<dir of messagesPath>/session.json` and classify it.
 * @returns {{kind: "step"|"human"|"unknown", reason: string}}
 */
export function classifyKiroSession(messagesPath) {
  if (!messagesPath) return { kind: "unknown", reason: "no_messages_path" };
  let raw;
  try {
    raw = readFileSync(join(dirname(messagesPath), "session.json"), "utf8");
  } catch (error) {
    return {
      kind: "unknown",
      reason: error?.code === "ENOENT" ? "session_json_missing" : "session_json_unreadable",
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unknown", reason: "session_json_invalid" };
  }
  return classifySessionJson(parsed);
}

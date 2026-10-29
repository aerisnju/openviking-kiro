/**
 * Decode Kiro's messages.jsonl into stable incremental user/assistant turns.
 *
 * messages.jsonl is append-only, one {id,timestamp,payload} record per line,
 * with ~15 distinct payload.type values. The parser is ALLOW-LIST driven —
 * only three types are meaningful and every other type is ignored:
 *   - turn_start                       → orders a turn (its executionId)
 *   - assistant with operationType Say → contributes assistant text
 *   - user                             → contributes user text
 * Several non-conversation types (turn_end, sub_agent_*, tool_*) also carry an
 * executionId, so a deny-list would let them create/reorder turns. Only
 * turn_start may create/order a turn id.
 *
 * user records carry NO executionId, so a pending user message is attached to
 * the NEXT remembered execution purely by ordering (the Kimi Code pattern) and
 * does NOT depend on _meta.kiro.userMessageTag (present only in newer builds).
 * A trailing user with no following execution is left PENDING (no synthetic
 * turn) and captured on the next Stop under its real executionId — this avoids
 * a double-send that a per-record synthetic id would cause (Finding 5).
 */

import { existsSync, readFileSync } from "node:fs";
import { sanitizeCapturedText } from "../../memory-plugin-shared/lib/capture-utils.mjs";
import { resolveKiroMessagesPath } from "./kiro-session.mjs";

export function cleanKiroText(value) {
  if (value == null) return "";
  const text = Array.isArray(value)
    ? value
        .map((part) => (typeof part === "string" ? part : part?.text || ""))
        .filter(Boolean)
        .join("\n")
    : typeof value === "object" && typeof value.text === "string"
      ? value.text
      : String(value);
  return sanitizeCapturedText(text);
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    if (content && typeof content === "object" && typeof content.text === "string") {
      return content.text;
    }
    return "";
  }
  return content
    .map((part) => (typeof part === "string" ? part : part?.text || ""))
    .filter(Boolean)
    .join("\n");
}

export function extractUnseenKiroTurns(messagesPath, lastTurnId = null) {
  if (!messagesPath || !existsSync(messagesPath)) return { status: "missing", turns: [] };
  let raw;
  try {
    raw = readFileSync(messagesPath, "utf8");
  } catch (error) {
    return { status: "unreadable", turns: [], error: error?.code || "read_failed" };
  }

  const users = new Map();
  const userTags = new Map();
  const assistants = new Map();
  const order = [];
  let pendingUser = "";
  let pendingTag = null;

  const remember = (value) => {
    const turnId = String(value);
    if (!order.includes(turnId)) order.push(turnId);
    return turnId;
  };
  const attachPending = (value) => {
    const turnId = remember(value);
    if (pendingUser) {
      users.set(
        turnId,
        `${users.get(turnId) || ""}${users.has(turnId) ? "\n" : ""}${pendingUser}`,
      );
      if (pendingTag != null && !userTags.has(turnId)) userTags.set(turnId, pendingTag);
      pendingUser = "";
      pendingTag = null;
    }
    return turnId;
  };

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record?.payload;
    if (!payload || typeof payload !== "object") continue;

    // ── Allow-list, everything else ignored ──────────────────────────────
    if (payload.type === "user") {
      const text = textFromContent(payload.content);
      if (text) pendingUser = pendingUser ? `${pendingUser}\n${text}` : text;
      const tag = payload?._meta?.kiro?.userMessageTag;
      if (tag != null) pendingTag = tag;
      continue;
    }
    if (payload.type === "turn_start") {
      if (payload.executionId != null) attachPending(payload.executionId);
      continue;
    }
    if (payload.type === "assistant" && payload.operationType === "Say") {
      if (payload.executionId == null) continue;
      const turnId = attachPending(payload.executionId);
      const text = textFromContent(payload.content);
      if (text) assistants.set(turnId, `${assistants.get(turnId) || ""}${text}`);
      continue;
    }
    // turn_end, session_metadata, session_start, session_event,
    // pending_interaction, interaction_resolved, steering_inclusion,
    // sub_agent_start, sub_agent_complete, tombstone, usage_summary,
    // tool_call, tool_result, assistant/Reasoning — all dropped.
  }

  const turns = [];
  const lastIndex =
    lastTurnId == null || lastTurnId === "" ? -1 : order.indexOf(String(lastTurnId));
  for (const turnId of order.slice(lastIndex + 1)) {
    const user = cleanKiroText(users.get(turnId) || "");
    const assistant = cleanKiroText(assistants.get(turnId) || "");
    if (user) {
      const turn = { role: "user", content: user, turnId };
      if (userTags.has(turnId)) turn.userMessageTag = userTags.get(turnId);
      turns.push(turn);
    }
    if (assistant) turns.push({ role: "assistant", content: assistant, turnId });
  }
  return { status: "ok", turns };
}

export function buildKiroTurns(input = {}, state = {}) {
  const messagesPath = resolveKiroMessagesPath(input, undefined, {
    log: state.__log,
    state,
  });
  return extractUnseenKiroTurns(messagesPath, state.lastTurnId || null);
}

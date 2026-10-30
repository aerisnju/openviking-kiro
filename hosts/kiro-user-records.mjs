/**
 * Classify a Kiro `user` transcript record as "typed by the human" or
 * "injected by the Kiro harness".
 *
 * Why this exists: messages.jsonl uses payload.type "user" for more than human
 * prompts. Kiro's workflow engine queues its own events as `user` records too
 * (source "steer": `_kiro/workflow/*` JSON-RPC events, step reports), and it
 * re-delivers them as synthetic user messages (`[WORKFLOW NOTIFICATION]`,
 * `A workflow you launched (...)`). Captured as user speech they pollute memory
 * extraction (and can be ~90 000 characters each).
 *
 * The rules are negative and structural, derived from a full scan of 77 real
 * sessions (127 steer + 15 synthetic injected records, 109 human prompts; see
 * DESIGN.md "Capture filtering"). No positive "human" key exists across Kiro
 * builds (`userMessageTag` is on only 66 of the 109 human records), so anything
 * that matches no rule is KEPT: losing a genuine human message is the worse
 * error. Rules, in order:
 *
 *   R3  `_meta.kiro.syntheticUserMessageReason` present      -> drop (any value)
 *   R2  `source === "steer"` AND one of: `_meta.kiro.notification`,
 *       `_meta.kiro.steeringClearedIds`, or empty text        -> drop
 *       A steer record with NONE of these is kept: nothing in the corpus shows
 *       how Kiro tags a human message typed mid-turn, so R2 is deliberately
 *       narrow.
 *   R4  start-anchored text backstop for builds that omit the meta keys:
 *       text (trimStart) begins with a `_kiro/` JSON-RPC object,
 *       `[WORKFLOW NOTIFICATION]`, `<notification `, or
 *       `A workflow you launched (`                           -> drop
 *   R5  size backstop: text longer than 12 000 chars whose trimmed form starts
 *       with `{`, `[` or `<`                                   -> drop
 *       (human max in the corpus is 2 186 chars; the shared captureMaxLength
 *       truncates at 24 000 instead of dropping, so an 88 717-char event would
 *       otherwise still send 24 000 chars)
 *
 * Old builds (`source:"chat"`, or no `_meta`/`source` at all) match no rule.
 * The function is pure and never returns the record content.
 */

export const OVERSIZED_STRUCTURED_CHARS = 12_000;

const NOTIFICATION_PREFIXES = ["[WORKFLOW NOTIFICATION]", "<notification ", "A workflow you launched ("];
const KIRO_JSONRPC_HEAD = /"method"\s*:\s*"_kiro\//;

export function textFromContent(content) {
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

const present = (value) => value !== undefined && value !== null;

/**
 * @param {object} payload a messages.jsonl record's `payload`
 * @returns {{keep: boolean, reason: string}} reason is a short constant, never content
 */
export function classifyKiroUserRecord(payload) {
  if (!payload || typeof payload !== "object" || payload.type !== "user") {
    return { keep: true, reason: "not_a_user_record" };
  }
  const meta = payload._meta?.kiro;
  const text = textFromContent(payload.content);

  if (meta && typeof meta === "object") {
    if (present(meta.syntheticUserMessageReason) && meta.syntheticUserMessageReason !== "") {
      return { keep: false, reason: "synthetic_user_message" };
    }
  }

  if (payload.source === "steer") {
    if (meta && typeof meta === "object") {
      if (present(meta.notification)) return { keep: false, reason: "steer_notification" };
      if (present(meta.steeringClearedIds)) return { keep: false, reason: "steer_cleared" };
    }
    if (!text.trim()) return { keep: false, reason: "steer_empty" };
  }

  const head = text.trimStart();
  if (NOTIFICATION_PREFIXES.some((prefix) => head.startsWith(prefix))) {
    return { keep: false, reason: "notification_envelope" };
  }
  if (head.startsWith("{") && KIRO_JSONRPC_HEAD.test(head.slice(0, 300))) {
    return { keep: false, reason: "kiro_jsonrpc_event" };
  }

  if (text.length > OVERSIZED_STRUCTURED_CHARS) {
    const first = text.trim()[0];
    if (first === "{" || first === "[" || first === "<") {
      return { keep: false, reason: "oversized_structured" };
    }
  }

  return { keep: true, reason: payload.source === "steer" ? "steer_unmarked_kept" : "human" };
}

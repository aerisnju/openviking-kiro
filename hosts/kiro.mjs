/**
 * Kiro adapter — a thin host on OpenViking's agent-hook-plugin framework,
 * mirroring the ZCode adapter. All memory logic (recall, capture filtering,
 * HTTP, retry queue, MCP transport, credentials, session model) is reused by
 * import; this adapter only supplies what differs for Kiro.
 *
 * Kiro differs from ZCode in four hard ways (see DESIGN.md): per-file v1 hook
 * schema, permissionDecision "ask" (never "deny"), capture from messages.jsonl
 * (not a rollout file), and glob-based session-dir discovery with sess_-prefix
 * tolerance.
 */

import {
  addAgentMessages,
  commitAgentSession,
} from "../../memory-plugin-shared/lib/agent-hook-runtime.mjs";
import { kiroPreToolUseOutput } from "./kiro-guard.mjs";
import { buildKiroTurns, cleanKiroText } from "./kiro-turns.mjs";
import { applyKiroCaptureResult, buildKiroCapturePlan } from "./kiro-capture.mjs";

export const kiro = {
  prefix: "ki-",
  tracksPendingPrompt: true, // keep last prompt for capture fallback / cleanup
  capturesOnlyWhenEnabled: true, // respect cfg capture switch
  detachesCapture: false, // Kiro Stop tolerates inline work; bounded by requestBudgets
  stages: {
    "session-start": "start",
    "user-prompt-submit": "prompt",
    stop: "capture",
  },
  requestBudgets: { stop: 25_000 }, // abort ~5s before Kiro's 30s Stop kill so state persists
  envelope(event, block) {
    // Capture (stop) returns no block, so hook.mjs's emit("") yields !block and
    // returns null here — only session-start / user-prompt-submit ever reach
    // the return below with a real block. hookEventName is explicit for all
    // events so a stray stop block can never be mislabeled UserPromptSubmit; an
    // unexpected event falls through to null.
    if (!block) return null;
    const hookEventName =
      event === "session-start"
        ? "SessionStart"
        : event === "user-prompt-submit"
          ? "UserPromptSubmit"
          : null;
    if (!hookEventName) return null;
    return { hookSpecificOutput: { hookEventName, additionalContext: block } };
  },
  guard: (input) => kiroPreToolUseOutput(input), // ask-not-deny, from ./kiro-guard.mjs
  normalizeInput: (input) => {
    // stdin is snake_case. Reconcile the session id before resolveNativeSessionId:
    // stdin session_id (primary), stdin sessionId (camelCase), env KIRO_SESSION_ID.
    const sessionId =
      input.session_id || input.sessionId || process.env.KIRO_SESSION_ID || "";
    return sessionId && sessionId !== input.session_id
      ? { ...input, session_id: sessionId }
      : input;
  },
  prompt: (input) => cleanKiroText(String(input.prompt ?? "").trim()),
  async capture(ctx, state) {
    // Thread the visible logger + once-per-session flag into the locator so a
    // present-but-unmatched session is diagnosed loudly, exactly once.
    const parseState = { ...state, __log: ctx.log };
    const turns = buildKiroTurns(ctx.input, parseState); // reads messages.jsonl
    const plan = buildKiroCapturePlan(turns, state, ctx.cfg);
    // Fail-closed: skip silently when there is nothing new. Persist the
    // loggedUnresolved flag the locator may have set so the warn fires once.
    if (plan.toSend.length === 0) {
      return parseState.loggedUnresolved && !state.loggedUnresolved
        ? { ...state, loggedUnresolved: true }
        : null;
    }
    const result = await addAgentMessages(
      ctx.fetchJSON,
      ctx.sessionId,
      plan.payloads,
      ctx.peerId,
    );
    const { captured, ...nextState } = applyKiroCaptureResult(state, plan, result);
    let nextCount = Number(state.capturedSinceCommit || 0) + captured;
    if (captured > 0) {
      const committed = await commitAgentSession(ctx.fetchJSON, ctx.sessionId, ctx.log);
      if (committed.ok) nextCount = 0; // commit on every Stop is acceptable
    }
    return {
      ...nextState,
      capturedSinceCommit: nextCount,
      ...(parseState.loggedUnresolved ? { loggedUnresolved: true } : {}),
    };
  },
};

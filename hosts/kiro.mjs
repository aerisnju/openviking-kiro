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

import { readFileSync } from "node:fs";
import {
  addAgentMessages,
  commitAgentSession,
} from "../../memory-plugin-shared/lib/agent-hook-runtime.mjs";
import { kiroPreToolUseOutput } from "./kiro-guard.mjs";
import { cleanKiroText, extractUnseenKiroTurns } from "./kiro-turns.mjs";
import { resolveKiroMessagesPath } from "./kiro-session.mjs";
import { classifyKiroSession } from "./kiro-session-kind.mjs";
import { applyKiroCaptureResult, buildKiroCapturePlan } from "./kiro-capture.mjs";

/**
 * Name this integration to the shared runtime, the way upstream's installer does
 * with OPENVIKING_INTEGRATION_ID / _VERSION: the runtime puts the version in
 * the User-Agent it sends (cosmetic). Kiro hook commands carry no env prefix
 * (the shell is not known), so the adapter sets them when it is imported, which
 * happens before hook.mjs loads its config. An operator-set value wins.
 */
export function ensureIntegrationEnv(env = process.env) {
  if (!env.OPENVIKING_INTEGRATION_ID) env.OPENVIKING_INTEGRATION_ID = "openviking-memory";
  if (!env.OPENVIKING_INTEGRATION_VERSION) {
    try {
      const manifest = new URL("../plugin.json", import.meta.url);
      const version = JSON.parse(readFileSync(manifest, "utf8")).version;
      if (typeof version === "string" && version) env.OPENVIKING_INTEGRATION_VERSION = version;
    } catch {
      // No manifest next to the bundle (e.g. a bare checkout of hosts/): the UA keeps 0.0.0.
    }
  }
  return env;
}
ensureIntegrationEnv();

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
  // Shared per-hook request deadline (scripts/request-budget.mjs, ms). Each is
  // below the hook timeout scripts/install.mjs renders (30 / 20 / 30 s) so the
  // hook ends and persists state before Kiro would kill it. Same values as
  // upstream's zcode adapter.
  requestBudgets: { "session-start": 25_000, "user-prompt-submit": 17_000, stop: 25_000 },
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
    const messagesPath = resolveKiroMessagesPath(ctx.input, undefined, {
      log: ctx.log,
      state: parseState,
    });

    // Capture only human-facing sessions. A workflow/sub-agent step session is
    // skipped BEFORE its transcript is read (nothing is read, sent or committed).
    // "unknown" (session.json missing/unreadable) also skips this Stop, but
    // without touching state, so the cursor stays put and the next Stop retries.
    // See hosts/kiro-session-kind.mjs for the asymmetry rationale.
    if (messagesPath) {
      const kind = classifyKiroSession(messagesPath);
      if (kind.kind === "step") {
        if (state.loggedStepSession) return null;
        ctx.log("capture_skipped_step_session", { reason: kind.reason, session_id: ctx.sessionId });
        return { ...state, loggedStepSession: true };
      }
      if (kind.kind === "unknown") {
        ctx.log("capture_deferred_session_kind_unknown", { reason: kind.reason, session_id: ctx.sessionId });
        return null;
      }
    }

    // extractUnseenKiroTurns() returns { status, turns, userRecords } (same
    // shape as Kimi's builder), NOT an array: the plan builder iterates its
    // first argument, so the turns array must be unpacked here. (0.1.0 passed
    // the whole object and threw "turns is not iterable" on every Stop.)
    const transcript = extractUnseenKiroTurns(messagesPath, state.lastTurnId || null); // reads messages.jsonl
    const droppedUserRecords = transcript.userRecords?.dropped || {};
    if (Object.keys(droppedUserRecords).length > 0) {
      // Counts and reasons only, never the dropped content.
      ctx.log("capture_user_records_dropped", {
        session_id: ctx.sessionId,
        kept: transcript.userRecords.kept,
        dropped: droppedUserRecords,
      });
    }
    if (transcript.status !== "ok") {
      // "missing" (unresolved session / no transcript yet) or "unreadable":
      // nothing to capture. Say so in the debug log, as Kimi does.
      ctx.log(`capture_${transcript.status}`, transcript.error ? { error: transcript.error } : {});
    }
    const plan = buildKiroCapturePlan(transcript.turns, state, ctx.cfg);
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

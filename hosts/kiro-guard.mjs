/**
 * Kiro PreToolUse guard — ask-not-deny envelope helper.
 *
 * Kiro supports permissionDecision "ask" (prompts the user), never "deny".
 * The guard reuses the shared URI detection but wraps the result in an `ask`
 * envelope, making it advisory rather than a hard block. The envelope carries
 * hookEventName:"PreToolUse" to match the shared deny envelope and this host's
 * SessionStart/UserPromptSubmit envelopes — the safe, documented shape.
 *
 * INVARIANT: return {} (never null/undefined) on no-opinion, since
 * runUriGuardHook calls Object.keys() on the result.
 */

import { evaluateUriGuard, readToolEvent } from "../../memory-plugin-shared/lib/uri-guard.mjs";

// Kiro's read-family tool names are NOT keys in the shared DEFAULT_TOOL_HINTS
// table (read/glob/grep/edit/write/bash/...). evaluateUriGuard only lowercases
// the tool name and looks it up in that table, so passing "read_file" straight
// through yields no hint and the guard never fires. This map is MANDATORY — it
// translates each Kiro tool name to the hint key the shared table understands.
export const KIRO_TOOL_HINT = {
  read_file: "read",
  read_code: "read",
  list_directory: "glob",
  file_search: "glob",
  grep_search: "grep",
};

export function askHookSpecificOutput(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: reason,
    },
  };
}

export function kiroPreToolUseOutput(event = {}) {
  const { toolName, toolInput } = readToolEvent(event);
  const hintName = KIRO_TOOL_HINT[String(toolName || "").trim().toLowerCase()];
  if (!hintName) return {}; // unmapped tool → no opinion
  const decision = evaluateUriGuard(hintName, toolInput); // hintName IS a hint key
  return decision ? askHookSpecificOutput(decision.reason) : {};
}

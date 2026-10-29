import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  KIRO_TOOL_HINT,
  askHookSpecificOutput,
  kiroPreToolUseOutput,
} from "../hosts/kiro-guard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

test("read_file with a viking:// path yields an ask envelope carrying hookEventName PreToolUse", () => {
  const out = kiroPreToolUseOutput({
    tool_name: "read_file",
    tool_input: { path: "viking://user/default/memories" },
  });
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /OpenViking MCP/);
});

test("all five Kiro read-family tool names map and fire on a viking:// path", () => {
  for (const [tool, arg] of [
    ["read_file", { path: "viking://user/default/memories" }],
    ["read_code", { path: "viking://user/default/notes" }],
    ["list_directory", { path: "viking://user/default/" }],
    ["file_search", { path: "viking://resources/docs" }],
    ["grep_search", { path: "viking://resources/docs", pattern: "hello" }],
  ]) {
    const out = kiroPreToolUseOutput({ tool_name: tool, tool_input: arg });
    assert.equal(
      out.hookSpecificOutput?.permissionDecision,
      "ask",
      `${tool} should ask`,
    );
    assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  }
  // Regression guard: the map is what makes raw Kiro names resolve to hint keys.
  assert.deepEqual(Object.keys(KIRO_TOOL_HINT).sort(), [
    "file_search",
    "grep_search",
    "list_directory",
    "read_code",
    "read_file",
  ]);
});

test("read_file with a normal local path yields no opinion ({})", () => {
  const out = kiroPreToolUseOutput({
    tool_name: "read_file",
    tool_input: { path: "src/main.ts" },
  });
  assert.deepEqual(out, {});
});

test("an unmapped/shell-like tool with a viking:// URI is never guarded", () => {
  const out = kiroPreToolUseOutput({
    tool_name: "execute_pwsh",
    tool_input: { command: "cat viking://user/default/memories" },
  });
  assert.deepEqual(out, {});
});

test("a viking:// URI only in a content key is not flagged (content-key skip)", () => {
  const out = kiroPreToolUseOutput({
    tool_name: "read_file",
    tool_input: { path: "notes.md", content: "see viking://user/default/x" },
  });
  assert.deepEqual(out, {});
});

test("no viking:// path at all yields {} (never null/undefined)", () => {
  const out = kiroPreToolUseOutput({ tool_name: "read_file", tool_input: {} });
  assert.deepEqual(out, {});
  assert.notEqual(out, null);
});

test("askHookSpecificOutput shape is stable", () => {
  assert.deepEqual(askHookSpecificOutput("hi"), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: "hi",
    },
  });
});

test(".mcp.json template carries the __NODE_BIN__ placeholder the installer replaces with process.execPath", () => {
  const tpl = JSON.parse(readFileSync(join(repoRoot, "hosts", "kiro", ".mcp.json"), "utf8"));
  assert.equal(tpl.mcpServers.openviking.command, "__NODE_BIN__");
  assert.equal(tpl.mcpServers.openviking.env.OPENVIKING_HOOK_SOURCE, "kiro");
  assert.equal(tpl.mcpServers.openviking.disabled, false);
  assert.match(tpl.mcpServers.openviking.args[0], /mcp-proxy\.mjs$/);
});

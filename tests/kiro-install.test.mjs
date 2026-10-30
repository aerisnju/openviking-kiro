import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { makeTmp } from "./helpers/tmp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const INSTALL = join(REPO, "scripts", "install.mjs");
const UNINSTALL = join(REPO, "scripts", "uninstall.mjs");

function freshPrefix() {
  return makeTmp("install");
}

function seedSharedLib(prefix) {
  const lib = join(prefix, ".openviking", "agent-integrations", "memory-plugin-shared", "lib");
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, "agent-hook-runtime.mjs"), "// stub\n");
  return lib;
}

function runInstall(prefix, extra = []) {
  return spawnSync(process.execPath, [INSTALL, "--prefix", prefix, ...extra], {
    encoding: "utf8",
  });
}

function runUninstall(prefix, extra = []) {
  return spawnSync(process.execPath, [UNINSTALL, "--prefix", prefix, ...extra], {
    encoding: "utf8",
  });
}

function hookPath(prefix, event) {
  return join(prefix, ".kiro", "hooks", `openviking-${event}.json`);
}

const mcpPath = (prefix) => join(prefix, ".kiro", "settings", "mcp.json");

test("preflight: without a shared lib, install exits non-zero and writes nothing", () => {
  const prefix = freshPrefix();
  const r = runInstall(prefix);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /shared runtime not found/);
  assert.equal(existsSync(join(prefix, ".kiro", "hooks")), false);
});

test("happy path: four well-formed v1 hook files with quoted absolute node commands", () => {
  const prefix = freshPrefix();
  seedSharedLib(prefix);
  const r = runInstall(prefix, ["--verify"]);
  assert.equal(r.status, 0, r.stderr);

  const expected = {
    "session-start": { trigger: "SessionStart", timeout: 30, script: "hook.mjs", matcher: undefined },
    "user-prompt-submit": { trigger: "UserPromptSubmit", timeout: 20, script: "hook.mjs", matcher: undefined },
    "pre-tool-use": {
      trigger: "PreToolUse",
      timeout: 5,
      script: "uri-guard.mjs",
      matcher: "read_file|read_code|list_directory|file_search|grep_search",
    },
    stop: { trigger: "Stop", timeout: 30, script: "hook.mjs", matcher: undefined },
  };
  const bundleScripts = join(prefix, ".openviking", "agent-integrations", "kiro", "scripts");
  for (const [event, exp] of Object.entries(expected)) {
    const raw = readFileSync(hookPath(prefix, event), "utf8");
    const obj = JSON.parse(raw); // valid JSON with escaped backslashes
    assert.equal(obj.version, "v1");
    assert.equal(obj.hooks.length, 1);
    const h = obj.hooks[0];
    assert.equal(h.trigger, exp.trigger);
    assert.equal(h.action.type, "command");
    assert.equal(h.action.timeout, exp.timeout);
    if (exp.matcher) assert.equal(h.matcher, exp.matcher);
    else assert.equal("matcher" in h, false);
    // matcher is a sibling of action, not nested.
    // command: quoted absolute path to the right script + <event> kiro.
    const scriptAbs = join(bundleScripts, exp.script);
    assert.equal(h.action.command, `node "${scriptAbs}" ${event} kiro`);
    assert.match(h.action.command, /^node "/); // path is quoted
    assert.ok(h.action.command.endsWith(`${event} kiro`));
  }
});

test("MCP merge preserves a pre-seeded server and adds openviking correctly", () => {
  const prefix = freshPrefix();
  seedSharedLib(prefix);
  mkdirSync(dirname(mcpPath(prefix)), { recursive: true });
  writeFileSync(
    mcpPath(prefix),
    JSON.stringify({ mcpServers: { playwright: { command: "npx", args: ["playwright"] } } }, null, 2),
  );
  const r = runInstall(prefix);
  assert.equal(r.status, 0, r.stderr);

  const merged = JSON.parse(readFileSync(mcpPath(prefix), "utf8"));
  assert.ok(merged.mcpServers.playwright, "pre-seeded server preserved");
  assert.equal(merged.mcpServers.playwright.command, "npx");
  const ov = merged.mcpServers.openviking;
  assert.ok(ov, "openviking added");
  assert.equal(ov.command, process.execPath);
  assert.equal(ov.env.OPENVIKING_HOOK_SOURCE, "kiro");
  assert.equal(ov.env.OPENVIKING_INTEGRATION_ID, "openviking-memory");
  assert.equal(
    ov.env.OPENVIKING_INTEGRATION_VERSION,
    JSON.parse(readFileSync(join(REPO, "plugin.json"), "utf8")).version,
  );
  assert.equal(ov.disabled, false);
  const proxyAbs = join(prefix, ".openviking", "agent-integrations", "kiro", "servers", "mcp-proxy.mjs");
  assert.equal(ov.args[0], proxyAbs);
});

test("copied bundle: kiro/hosts/kiro.mjs's ../../memory-plugin-shared/lib resolves to the stub", () => {
  const prefix = freshPrefix();
  const stubLib = seedSharedLib(prefix);
  const r = runInstall(prefix);
  assert.equal(r.status, 0, r.stderr);
  const bundleHost = join(prefix, ".openviking", "agent-integrations", "kiro", "hosts", "kiro.mjs");
  assert.ok(existsSync(bundleHost));
  // Relative ../../memory-plugin-shared/lib from kiro/hosts/ lands on the stub.
  const resolved = join(dirname(bundleHost), "..", "..", "memory-plugin-shared", "lib", "agent-hook-runtime.mjs");
  assert.ok(existsSync(resolved), "shared lib import resolves after copy");
  assert.equal(join(stubLib, "agent-hook-runtime.mjs"), resolved);
});

test("idempotency: run twice → hook files byte-identical and mcp unchanged", () => {
  const prefix = freshPrefix();
  seedSharedLib(prefix);
  runInstall(prefix);
  const firstHooks = {};
  for (const e of ["session-start", "user-prompt-submit", "pre-tool-use", "stop"]) {
    firstHooks[e] = readFileSync(hookPath(prefix, e));
  }
  const firstMcp = readFileSync(mcpPath(prefix));
  const r2 = runInstall(prefix);
  assert.equal(r2.status, 0, r2.stderr);
  for (const e of Object.keys(firstHooks)) {
    assert.equal(Buffer.compare(firstHooks[e], readFileSync(hookPath(prefix, e))), 0, `${e} byte-identical`);
  }
  assert.equal(Buffer.compare(firstMcp, readFileSync(mcpPath(prefix))), 0, "mcp unchanged");
});

test("ovcli.conf is untouched when present, and not created when absent", () => {
  const prefix = freshPrefix();
  seedSharedLib(prefix);
  const conf = join(prefix, ".openviking", "ovcli.conf");
  const original = 'url = "https://example.invalid"\napi_key = "SECRET"\n';
  writeFileSync(conf, original);
  runInstall(prefix);
  assert.equal(readFileSync(conf, "utf8"), original, "ovcli.conf byte-identical");

  const prefix2 = freshPrefix();
  seedSharedLib(prefix2);
  runInstall(prefix2);
  assert.equal(existsSync(join(prefix2, ".openviking", "ovcli.conf")), false, "not created");
});

test("--with-steering --with-skill copies both assets", () => {
  const prefix = freshPrefix();
  seedSharedLib(prefix);
  const r = runInstall(prefix, ["--with-steering", "--with-skill"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(prefix, ".kiro", "steering", "openviking-memory.md")));
  assert.ok(existsSync(join(prefix, ".kiro", "skills", "openviking-memory", "SKILL.md")));
});

test("uninstall removes exactly our hooks + mcp entry, leaving foreign entries intact", () => {
  const prefix = freshPrefix();
  seedSharedLib(prefix);
  // Pre-seed a foreign MCP server and an unrelated hook file.
  mkdirSync(dirname(mcpPath(prefix)), { recursive: true });
  writeFileSync(
    mcpPath(prefix),
    JSON.stringify({ mcpServers: { playwright: { command: "npx", args: ["playwright"] } } }, null, 2),
  );
  const conf = join(prefix, ".openviking", "ovcli.conf");
  writeFileSync(conf, "url = \"x\"\napi_key = \"y\"\n");
  runInstall(prefix, ["--with-steering", "--with-skill"]);
  // Add an unrelated hook file that must survive.
  const foreignHook = join(prefix, ".kiro", "hooks", "my-other-hook.json");
  writeFileSync(foreignHook, JSON.stringify({ version: "v1", hooks: [] }));

  const r = runUninstall(prefix, ["--purge-bundle", "--remove-steering"]);
  assert.equal(r.status, 0, r.stderr);

  for (const e of ["session-start", "user-prompt-submit", "pre-tool-use", "stop"]) {
    assert.equal(existsSync(hookPath(prefix, e)), false, `${e} removed`);
  }
  assert.ok(existsSync(foreignHook), "unrelated hook preserved");

  const mcp = JSON.parse(readFileSync(mcpPath(prefix), "utf8"));
  assert.equal(mcp.mcpServers.openviking, undefined, "openviking entry removed");
  assert.ok(mcp.mcpServers.playwright, "playwright preserved");

  // Shared lib and credentials intact.
  assert.ok(
    existsSync(join(prefix, ".openviking", "agent-integrations", "memory-plugin-shared", "lib", "agent-hook-runtime.mjs")),
    "shared lib intact",
  );
  assert.ok(existsSync(conf), "ovcli.conf intact");
  // Steering + skill + bundle removed.
  assert.equal(existsSync(join(prefix, ".kiro", "steering", "openviking-memory.md")), false);
  assert.equal(existsSync(join(prefix, ".kiro", "skills", "openviking-memory")), false);
  assert.equal(existsSync(join(prefix, ".openviking", "agent-integrations", "kiro")), false);
});

test("--dry-run lists every bundled script (incl. request-budget.mjs) and writes nothing", () => {
  const prefix = freshPrefix();
  seedSharedLib(prefix);
  mkdirSync(dirname(mcpPath(prefix)), { recursive: true });
  writeFileSync(
    mcpPath(prefix),
    JSON.stringify({ mcpServers: { other: { command: "x", env: { TOKEN: "foreign-env-marker" } } } }),
  );
  const r = runInstall(prefix, ["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /foreign-env-marker/, "foreign MCP server env is never echoed");
  assert.match(r.stdout, /other servers kept untouched: other/);
  for (const file of ["hook.mjs", "request-budget.mjs", "uri-guard.mjs"]) {
    assert.match(r.stdout, new RegExp(`\\+ scripts/${file.replace(".", "\\.")}`), file);
  }
  assert.doesNotMatch(r.stdout, /check-upstream|check-test-prereqs/);
  assert.equal(existsSync(join(prefix, ".kiro", "hooks")), false, "dry run wrote no hook files");
  assert.equal(existsSync(`${mcpPath(prefix)}.bak`), false, "dry run did not touch mcp.json");
  assert.doesNotMatch(readFileSync(mcpPath(prefix), "utf8"), /openviking/, "mcp.json not merged");
  assert.equal(
    existsSync(join(prefix, ".openviking", "agent-integrations", "kiro")),
    false,
    "dry run copied no bundle",
  );
});

test("uninstall is idempotent (nothing to remove → exit 0)", () => {
  const prefix = freshPrefix();
  const r = runUninstall(prefix);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nothing to remove/);
});

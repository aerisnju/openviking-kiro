/**
 * Contract between the vendored dispatcher (scripts/hook.mjs, scripts/uri-guard.mjs,
 * copied from upstream) and the Kiro adapter object. When upstream's hook.mjs
 * starts reading a new `host.<field>`, re-syncing it makes the first test here
 * fail, which is the signal to extend the adapter (see README, "Keeping in sync").
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { HOSTS } from "../hosts/index.mjs";
import { ensureIntegrationEnv, kiro } from "../hosts/kiro.mjs";
import { makeTmp } from "./helpers/tmp.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

// Every field an adapter may define, as consumed by upstream hook.mjs / uri-guard.mjs.
const REQUIRED = ["prefix", "stages", "envelope", "guard", "prompt", "capture"];
const OPTIONAL = [
  "normalizeInput",
  "tracksPendingPrompt",
  "capturesOnlyWhenEnabled",
  "detachesCapture",
  "requestBudgets",
  "profileStage",
];
const KNOWN = new Set([...REQUIRED, ...OPTIONAL]);

function consumedFields() {
  const found = new Set();
  for (const rel of ["scripts/hook.mjs", "scripts/uri-guard.mjs"]) {
    const src = read(rel);
    for (const m of src.matchAll(/\bhost\.(\w+)/g)) found.add(m[1]);
    for (const m of src.matchAll(/HOSTS\[[^\]]+\]\.(\w+)/g)) found.add(m[1]);
  }
  return found;
}

test("the dispatcher reads only adapter fields this adapter knows about", () => {
  const unknown = [...consumedFields()].filter((f) => !KNOWN.has(f));
  assert.deepEqual(
    unknown,
    [],
    `scripts/hook.mjs or scripts/uri-guard.mjs now reads adapter field(s) ${unknown.join(", ")}; ` +
      `extend hosts/kiro.mjs and this test`,
  );
});

test("the kiro adapter defines every required field with the right type", () => {
  assert.deepEqual(Object.keys(HOSTS), ["kiro"]);
  assert.equal(HOSTS.kiro, kiro);
  assert.equal(typeof kiro.prefix, "string");
  assert.match(kiro.prefix, /^[a-z]+-$/);
  assert.equal(typeof kiro.stages, "object");
  for (const field of ["envelope", "guard", "prompt", "capture"]) {
    assert.equal(typeof kiro[field], "function", field);
  }
  const extra = Object.keys(kiro).filter((k) => !KNOWN.has(k));
  assert.deepEqual(extra, [], "adapter defines a field the dispatcher never reads");
});

test("stages map each Kiro event to a stage hook.mjs implements", () => {
  assert.deepEqual(kiro.stages, {
    "session-start": "start",
    "user-prompt-submit": "prompt",
    stop: "capture",
  });
  // hook.mjs dispatches on exactly these stage names.
  const src = read("scripts/hook.mjs");
  assert.ok(src.includes('stageName === "start"'));
  assert.ok(src.includes('stageName === "prompt"'));
  assert.ok(src.includes('return capture(ctx)'));
});

test("optional flags are booleans, profileStage (if set) is a stage hook.mjs knows", () => {
  for (const flag of ["tracksPendingPrompt", "capturesOnlyWhenEnabled", "detachesCapture"]) {
    assert.equal(typeof kiro[flag], "boolean", flag);
  }
  if (kiro.profileStage !== undefined) assert.ok(["session-start", "first-prompt"].includes(kiro.profileStage));
  assert.equal(typeof kiro.normalizeInput, "function");
});

test("envelope: a block becomes the hookSpecificOutput for its event; stop and empty give null", () => {
  assert.deepEqual(kiro.envelope("session-start", "B"), {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "B" },
  });
  assert.deepEqual(kiro.envelope("user-prompt-submit", "B"), {
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "B" },
  });
  assert.equal(kiro.envelope("stop", ""), null);
  assert.equal(kiro.envelope("stop", "B"), null);
  assert.equal(kiro.envelope("session-start", ""), null);
});

test("requestBudgets cover all three events and sit below the installed hook timeouts", () => {
  assert.deepEqual(kiro.requestBudgets, {
    "session-start": 25_000,
    "user-prompt-submit": 17_000,
    stop: 25_000,
  });

  const prefix = makeTmp("contract");
  const lib = join(prefix, ".openviking", "agent-integrations", "memory-plugin-shared", "lib");
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, "agent-hook-runtime.mjs"), "// stub\n");
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "install.mjs"), "--prefix", prefix], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);

  for (const event of Object.keys(kiro.stages)) {
    const hook = JSON.parse(readFileSync(join(prefix, ".kiro", "hooks", `openviking-${event}.json`), "utf8"));
    const timeoutMs = hook.hooks[0].action.timeout * 1000;
    const budget = kiro.requestBudgets[event];
    assert.ok(budget < timeoutMs, `${event}: budget ${budget} ms must be below the ${timeoutMs} ms hook timeout`);
    assert.ok(timeoutMs - budget >= 3000, `${event}: keep >= 3 s to persist state before Kiro kills the hook`);
  }
});

test("ensureIntegrationEnv names the integration; an operator value wins", () => {
  const manifest = JSON.parse(read("plugin.json"));
  const env = ensureIntegrationEnv({});
  assert.equal(env.OPENVIKING_INTEGRATION_ID, "openviking-memory");
  assert.equal(env.OPENVIKING_INTEGRATION_VERSION, manifest.version);
  const custom = ensureIntegrationEnv({ OPENVIKING_INTEGRATION_VERSION: "9.9.9" });
  assert.equal(custom.OPENVIKING_INTEGRATION_VERSION, "9.9.9");
});

test("versions agree across package.json, plugin.json and openviking.integration.json", () => {
  const versions = [
    JSON.parse(read("package.json")).version,
    JSON.parse(read("plugin.json")).version,
    JSON.parse(read("hosts/kiro/openviking.integration.json")).version,
  ];
  assert.equal(new Set(versions).size, 1, `versions differ: ${versions.join(", ")}`);
});

test("the installer bundles scripts/request-budget.mjs (hook.mjs imports it) and no dev tools", () => {
  const prefix = makeTmp("bundle");
  const lib = join(prefix, ".openviking", "agent-integrations", "memory-plugin-shared", "lib");
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, "agent-hook-runtime.mjs"), "// stub\n");
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "install.mjs"), "--prefix", prefix], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const scripts = join(prefix, ".openviking", "agent-integrations", "kiro", "scripts");
  const listing = readFileSync(join(scripts, "hook.mjs"), "utf8");
  assert.match(listing, /from "\.\/request-budget\.mjs"/);
  const have = new Set(readdirSync(scripts));
  assert.ok(have.has("request-budget.mjs"), "request-budget.mjs bundled");
  assert.ok(have.has("hook.mjs") && have.has("uri-guard.mjs"));
  assert.equal(have.has("check-upstream.mjs"), false, "maintainer tool not bundled");
  assert.equal(have.has("check-test-prereqs.mjs"), false, "maintainer tool not bundled");
});

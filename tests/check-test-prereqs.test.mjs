import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { findSharedLib } from "../scripts/check-test-prereqs.mjs";
import { makeTmp } from "./helpers/tmp.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO, "scripts", "check-test-prereqs.mjs");

// A throwaway "repo" whose parent has (or lacks) the memory-plugin-shared sibling.
function fakeRepo({ withSibling }) {
  const parent = makeTmp("prereq");
  const repo = join(parent, "openviking-kiro");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  copyFileSync(SCRIPT, join(repo, "scripts", "check-test-prereqs.mjs"));
  if (withSibling) {
    const lib = join(parent, "memory-plugin-shared", "lib");
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, "agent-hook-runtime.mjs"), "// stub\n");
  }
  return { parent, repo, script: join(repo, "scripts", "check-test-prereqs.mjs") };
}

test("prereq check passes when the sibling shared lib is present", () => {
  const { script, repo } = fakeRepo({ withSibling: true });
  const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(findSharedLib(repo));
});

test("prereq check fails with the exact one-time fix for Windows and macOS/Linux", () => {
  const { script, parent, repo } = fakeRepo({ withSibling: false });
  const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.equal(findSharedLib(repo), "");
  const sibling = join(parent, "memory-plugin-shared");
  assert.ok(r.stderr.includes(`New-Item -ItemType Junction -Path "${sibling}" -Target`), r.stderr);
  assert.ok(r.stderr.includes("memory-plugin-shared"));
  assert.ok(r.stderr.includes(`ln -s ~/.openviking/agent-integrations/memory-plugin-shared "${sibling}"`), r.stderr);
  assert.match(r.stderr, /official OpenViking memory\s+plugin|Install an official OpenViking memory/);
});

test("package.json wires pretest to the check and test to the quoted glob", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  assert.equal(pkg.scripts.pretest, "node scripts/check-test-prereqs.mjs");
  assert.equal(pkg.scripts.test, 'node --test "tests/**/*.test.mjs"');
  assert.equal(pkg.scripts["check-upstream"], "node scripts/check-upstream.mjs");
  assert.equal(pkg.scripts["sync-upstream"], "node scripts/check-upstream.mjs --sync");
});

#!/usr/bin/env node

/**
 * `npm test` prerequisite check (run as the `pretest` script).
 *
 * The host modules import the OpenViking shared runtime with the relative path
 * ../../memory-plugin-shared/lib, which from a checkout of this repo is the
 * sibling directory <repo-parent>/memory-plugin-shared. A fresh clone does not
 * have it, so every import fails with a confusing ERR_MODULE_NOT_FOUND. This
 * check fails early with the one-time fix instead.
 *
 * Zero dependencies, read-only.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_FILE = "agent-hook-runtime.mjs";

/** Where the tests expect the shared runtime: <repo-parent>/memory-plugin-shared. */
export function sharedSiblingDir(repoRoot = REPO_ROOT) {
  return join(dirname(repoRoot), "memory-plugin-shared");
}

/** Absolute path to the sibling's lib/ when it is usable, else "". */
export function findSharedLib(repoRoot = REPO_ROOT) {
  const lib = join(sharedSiblingDir(repoRoot), "lib");
  return existsSync(join(lib, RUNTIME_FILE)) ? lib : "";
}

export function fixInstructions(repoRoot = REPO_ROOT) {
  const sibling = sharedSiblingDir(repoRoot);
  const installed = join(homedir(), ".openviking", "agent-integrations", "memory-plugin-shared");
  return [
    `openviking-kiro tests: the shared OpenViking runtime is not reachable at`,
    `  ${join(sibling, "lib", RUNTIME_FILE)}`,
    ``,
    `The host modules import ../../memory-plugin-shared/lib, which from this checkout is`,
    `a sibling of the repo folder. Create that sibling once, as a link to the runtime an`,
    `official OpenViking memory plugin installs under ~/.openviking/agent-integrations/.`,
    ``,
    `Windows (PowerShell):`,
    `  New-Item -ItemType Junction -Path "${sibling}" -Target "${installed}"`,
    ``,
    `macOS / Linux:`,
    `  ln -s ~/.openviking/agent-integrations/memory-plugin-shared "${sibling}"`,
    ``,
    installed && existsSync(installed)
      ? `(The installed runtime was found at ${installed}; only the link is missing.)`
      : `The installed runtime was NOT found either. Install an official OpenViking memory\n` +
        `plugin first (Cursor, TRAE, ZCode, Kimi Code or CodeBuddy: see\n` +
        `https://docs.openviking.ai/ , Agent integrations), then create the link above.`,
  ].join("\n");
}

function main() {
  if (findSharedLib()) return 0;
  process.stderr.write(`${fixInstructions()}\n`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main());
}

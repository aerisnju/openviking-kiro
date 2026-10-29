#!/usr/bin/env node

/**
 * Uninstaller for the OpenViking Kiro memory host. Removes ONLY what install
 * added: the four openviking-*.json hooks we own, the openviking MCP entry (if
 * ours), and — opt-in — the copied bundle and steering/skill assets. Never
 * touches the shared lib, credentials (ovcli.conf), other hosts, or Kiro
 * native config. Idempotent. --prefix redirects both roots.
 *
 * Usage: uninstall.mjs [--prefix <dir>] [--purge-bundle] [--remove-steering]
 */

import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOOK_EVENTS = ["session-start", "user-prompt-submit", "pre-tool-use", "stop"];

function parseArgs(argv) {
  const args = { prefix: null, purgeBundle: false, removeSteering: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prefix") args.prefix = argv[++i];
    else if (a === "--purge-bundle") args.purgeBundle = true;
    else if (a === "--remove-steering") args.removeSteering = true;
  }
  return args;
}

function resolvePaths(prefix) {
  const HOME_BASE = prefix || homedir();
  const KIRO_DIR = join(HOME_BASE, ".kiro");
  const OV_DIR = join(HOME_BASE, ".openviking", "agent-integrations");
  return {
    HOOKS_DIR: join(KIRO_DIR, "hooks"),
    MCP_PATH: join(KIRO_DIR, "settings", "mcp.json"),
    STEERING_DIR: join(KIRO_DIR, "steering"),
    SKILLS_DIR: join(KIRO_DIR, "skills"),
    KIRO_BUNDLE: join(OV_DIR, "kiro"),
  };
}

function ownsHookFile(content) {
  // Ours if the command references our scripts under agent-integrations.
  return (
    /agent-integrations/.test(content) &&
    /(hook\.mjs|uri-guard\.mjs)/.test(content) &&
    /\bkiro\b/.test(content)
  );
}

function writeAtomic(targetPath, content) {
  const tmp = `${targetPath}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, targetPath);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const P = resolvePaths(args.prefix);
  const log = (...m) => process.stdout.write(m.join(" ") + "\n");
  const removed = [];

  // 1. Hook files — only ours.
  for (const event of HOOK_EVENTS) {
    const target = join(P.HOOKS_DIR, `openviking-${event}.json`);
    if (!existsSync(target)) continue;
    let content = "";
    try {
      content = readFileSync(target, "utf8");
    } catch {
      continue;
    }
    if (ownsHookFile(content)) {
      rmSync(target, { force: true });
      removed.push(target);
    }
  }

  // 2. MCP entry — only if ours.
  if (existsSync(P.MCP_PATH)) {
    let parsed = null;
    try {
      parsed = JSON.parse(readFileSync(P.MCP_PATH, "utf8"));
    } catch {
      parsed = null;
    }
    const entry = parsed?.mcpServers?.openviking;
    const isOurs =
      entry &&
      Array.isArray(entry.args) &&
      entry.args.some(
        (a) => typeof a === "string" && /agent-integrations/.test(a) && /mcp-proxy\.mjs$/.test(a),
      );
    if (isOurs) {
      delete parsed.mcpServers.openviking;
      writeAtomic(P.MCP_PATH, JSON.stringify(parsed, null, 2) + "\n");
      removed.push(`${P.MCP_PATH} (openviking entry)`);
    }
    const bak = `${P.MCP_PATH}.bak`;
    if (existsSync(bak)) {
      rmSync(bak, { force: true });
      removed.push(bak);
    }
  }

  // 3. Steering + skill (opt-in).
  if (args.removeSteering) {
    const steering = join(P.STEERING_DIR, "openviking-memory.md");
    if (existsSync(steering)) {
      rmSync(steering, { force: true });
      removed.push(steering);
    }
    const skill = join(P.SKILLS_DIR, "openviking-memory");
    if (existsSync(skill)) {
      rmSync(skill, { recursive: true, force: true });
      removed.push(skill);
    }
  }

  // 4. Bundle (opt-in). Never touch memory-plugin-shared.
  if (args.purgeBundle && existsSync(P.KIRO_BUNDLE)) {
    rmSync(P.KIRO_BUNDLE, { recursive: true, force: true });
    removed.push(P.KIRO_BUNDLE);
  }

  // 5. ovcli.conf — never touched.

  if (removed.length === 0) log("OpenViking Kiro host: nothing to remove.");
  else {
    log("OpenViking Kiro host removed:");
    for (const r of removed) log(`  - ${r}`);
  }
}

main();

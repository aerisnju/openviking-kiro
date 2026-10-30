#!/usr/bin/env node

/**
 * Cross-platform Node installer for the OpenViking Kiro memory host.
 *
 * User-level by default. Reuses the already-installed shared runtime at
 * ~/.openviking/agent-integrations/memory-plugin-shared/lib (NEVER creates it),
 * copies the Kiro bundle beside it, renders the four Kiro v1 hook files into
 * ~/.kiro/hooks/, and merges the openviking MCP server non-destructively.
 * Idempotent. --prefix redirects BOTH the .kiro and .openviking roots.
 *
 * Usage:
 *   install.mjs [--prefix <dir>] [--with-steering] [--with-skill]
 *               [--no-steering] [--dry-run] [--yes] [--verify]
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

// The four hooks, rendered directly from this table (no external template).
const HOOK_TABLE = [
  { event: "session-start", script: "hook.mjs", trigger: "SessionStart", timeout: 30 },
  { event: "user-prompt-submit", script: "hook.mjs", trigger: "UserPromptSubmit", timeout: 20 },
  {
    event: "pre-tool-use",
    script: "uri-guard.mjs",
    trigger: "PreToolUse",
    timeout: 5,
    matcher: "read_file|read_code|list_directory|file_search|grep_search",
  },
  { event: "stop", script: "hook.mjs", trigger: "Stop", timeout: 30 },
];

const HOOK_NAMES = {
  "session-start": "OpenViking Session Start",
  "user-prompt-submit": "OpenViking User Prompt Submit",
  "pre-tool-use": "OpenViking URI Guard",
  stop: "OpenViking Stop Capture",
};

function parseArgs(argv) {
  const args = { prefix: null, steering: null, skill: false, dryRun: false, yes: false, verify: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prefix") args.prefix = argv[++i];
    else if (a === "--with-steering") args.steering = true;
    else if (a === "--no-steering") args.steering = false;
    else if (a === "--with-skill") args.skill = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--yes" || a === "-y") args.yes = true;
    else if (a === "--verify") args.verify = true;
  }
  return args;
}

function resolvePaths(prefix) {
  const HOME_BASE = prefix || homedir();
  const KIRO_DIR = join(HOME_BASE, ".kiro");
  const OV_DIR = join(HOME_BASE, ".openviking", "agent-integrations");
  return {
    HOME_BASE,
    KIRO_DIR,
    HOOKS_DIR: join(KIRO_DIR, "hooks"),
    MCP_PATH: join(KIRO_DIR, "settings", "mcp.json"),
    STEERING_DIR: join(KIRO_DIR, "steering"),
    SKILLS_DIR: join(KIRO_DIR, "skills"),
    OV_DIR,
    SHARED_LIB: join(OV_DIR, "memory-plugin-shared", "lib"),
    KIRO_BUNDLE: join(OV_DIR, "kiro"),
    NODE_BIN: process.execPath,
  };
}

function renderHookFile(hook, bundle) {
  const scriptPath = join(bundle, "scripts", hook.script);
  const command = `node "${scriptPath}" ${hook.event} kiro`;
  const obj = {
    version: "v1",
    hooks: [
      {
        name: HOOK_NAMES[hook.event],
        trigger: hook.trigger,
        ...(hook.matcher ? { matcher: hook.matcher } : {}),
        action: { type: "command", command, timeout: hook.timeout },
      },
    ],
  };
  return JSON.stringify(obj, null, 2);
}

function bundleVersion() {
  try {
    const version = JSON.parse(readFileSync(join(REPO_ROOT, "plugin.json"), "utf8")).version;
    return typeof version === "string" ? version : "";
  } catch {
    return "";
  }
}

function mergeMcp(mcpPath, bundle, nodeBin) {
  let existing = {};
  if (existsSync(mcpPath)) {
    const raw = readFileSync(mcpPath, "utf8");
    if (raw.trim()) {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        throw new Error(`Cannot safely update ${mcpPath}: not valid JSON (${e.message})`);
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Cannot safely update ${mcpPath}: top-level value is not an object`);
      }
      existing = parsed;
    }
  }
  if (!existing.mcpServers || typeof existing.mcpServers !== "object") existing.mcpServers = {};
  existing.mcpServers.openviking = {
    command: nodeBin,
    args: [join(bundle, "servers", "mcp-proxy.mjs")],
    env: {
      OPENVIKING_HOOK_SOURCE: "kiro",
      // Same naming upstream's installer gives its MCP entries; the shared
      // runtime puts the version in its User-Agent (cosmetic).
      OPENVIKING_INTEGRATION_ID: "openviking-memory",
      ...(bundleVersion() ? { OPENVIKING_INTEGRATION_VERSION: bundleVersion() } : {}),
    },
    disabled: false,
  };
  return existing;
}

// Maintainer tools that live in scripts/ but are not part of the runtime bundle.
const DEV_ONLY_SCRIPTS = new Set(["check-upstream.mjs", "check-test-prereqs.mjs"]);
const bundleFilter = (src) => !DEV_ONLY_SCRIPTS.has(basename(src));

// Relative, forward-slash file list of a directory tree (for the dry-run plan).
function listFiles(dir, base = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!bundleFilter(entry.name)) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

function writeAtomic(targetPath, content) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, targetPath);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const P = resolvePaths(args.prefix);
  const log = (...m) => process.stdout.write(m.join(" ") + "\n");

  // 1. PREFLIGHT — the shared runtime must already exist. Never create it.
  const runtimeFile = join(P.SHARED_LIB, "agent-hook-runtime.mjs");
  if (!existsSync(P.SHARED_LIB) || !existsSync(runtimeFile)) {
    process.stderr.write(
      `openviking-kiro: shared runtime not found at ${P.SHARED_LIB}\n` +
        `Install or repair an OpenViking memory plugin first so the shared closure\n` +
        `(memory-plugin-shared/lib/agent-hook-runtime.mjs) is present, then re-run.\n`,
    );
    process.exit(1);
  }

  if (args.dryRun) log(`[dry-run] preflight OK: ${runtimeFile}`);

  // 2. COPY BUNDLE.
  const bundleItems = [
    ["hosts", join(REPO_ROOT, "hosts"), join(P.KIRO_BUNDLE, "hosts")],
    ["scripts", join(REPO_ROOT, "scripts"), join(P.KIRO_BUNDLE, "scripts")],
    ["servers", join(REPO_ROOT, "servers"), join(P.KIRO_BUNDLE, "servers")],
    ["plugin.json", join(REPO_ROOT, "plugin.json"), join(P.KIRO_BUNDLE, "plugin.json")],
    [
      "openviking.integration.json",
      join(REPO_ROOT, "hosts", "kiro", "openviking.integration.json"),
      join(P.KIRO_BUNDLE, "openviking.integration.json"),
    ],
    ["README.md", join(REPO_ROOT, "README.md"), join(P.KIRO_BUNDLE, "README.md")],
  ];
  if (args.dryRun) {
    for (const [name, src, dst] of bundleItems) {
      log(`[dry-run] copy ${name} -> ${dst}`);
      if (statSync(src).isDirectory()) {
        for (const file of listFiles(src)) log(`[dry-run]   + ${name}/${file}`);
      }
    }
  } else {
    mkdirSync(P.KIRO_BUNDLE, { recursive: true });
    for (const [, src, dst] of bundleItems) {
      cpSync(src, dst, { recursive: true, filter: bundleFilter });
    }
  }

  // 3. RENDER + WRITE HOOK FILES.
  for (const hook of HOOK_TABLE) {
    const content = renderHookFile(hook, P.KIRO_BUNDLE);
    const target = join(P.HOOKS_DIR, `openviking-${hook.event}.json`);
    if (args.dryRun) {
      log(`[dry-run] write ${target}:\n${content}`);
    } else {
      mkdirSync(P.HOOKS_DIR, { recursive: true });
      writeFileSync(target, content);
    }
  }

  // 4. MERGE MCP (non-destructive, atomic).
  const merged = mergeMcp(P.MCP_PATH, P.KIRO_BUNDLE, P.NODE_BIN);
  const mergedText = JSON.stringify(merged, null, 2) + "\n";
  const alreadyMatches =
    existsSync(P.MCP_PATH) && readFileSync(P.MCP_PATH, "utf8") === mergedText;
  if (args.dryRun) {
    // Print only our entry and the names of the others: foreign servers' env
    // blocks may hold credentials and must not be echoed.
    const others = Object.keys(merged.mcpServers).filter((name) => name !== "openviking");
    log(
      `[dry-run] merge MCP -> ${P.MCP_PATH} (other servers kept untouched: ${others.length ? others.join(", ") : "none"})\n` +
        `${JSON.stringify({ openviking: merged.mcpServers.openviking }, null, 2)}`,
    );
  } else if (!alreadyMatches) {
    if (existsSync(P.MCP_PATH)) {
      writeFileSync(`${P.MCP_PATH}.bak`, readFileSync(P.MCP_PATH), { mode: 0o600 });
    }
    writeAtomic(P.MCP_PATH, mergedText);
  }

  // 5. ovcli.conf — untouched by design.

  // 6. STEERING + SKILL (opt-in).
  const doSteering = args.steering === true || (args.steering === null && args.yes);
  const doSkill = args.skill === true || (args.steering === null && args.yes);
  const steeringSrc = join(REPO_ROOT, "kiro-assets", "steering", "openviking-memory.md");
  const skillSrc = join(REPO_ROOT, "kiro-assets", "skills", "openviking-memory");
  if (doSteering) {
    const dst = join(P.STEERING_DIR, "openviking-memory.md");
    if (args.dryRun) log(`[dry-run] copy steering -> ${dst}`);
    else {
      mkdirSync(P.STEERING_DIR, { recursive: true });
      cpSync(steeringSrc, dst);
    }
  }
  if (doSkill) {
    const dst = join(P.SKILLS_DIR, "openviking-memory");
    if (args.dryRun) log(`[dry-run] copy skill -> ${dst}`);
    else {
      mkdirSync(P.SKILLS_DIR, { recursive: true });
      cpSync(skillSrc, dst, { recursive: true });
    }
  }

  // 7. SUMMARY + optional --verify.
  if (!args.dryRun) {
    log(`OpenViking Kiro host installed.`);
    log(`  bundle:   ${P.KIRO_BUNDLE}`);
    log(`  hooks:    ${P.HOOKS_DIR}\\openviking-{session-start,user-prompt-submit,pre-tool-use,stop}.json`);
    log(`  mcp:      ${P.MCP_PATH} (openviking server merged)`);
    log(`  steering: ${doSteering ? "installed" : "skipped"}`);
    log(`  skill:    ${doSkill ? "installed" : "skipped"}`);
    log(`Restart Kiro, then run a prompt to see recall injection.`);
    if (!doSteering && !doSkill) {
      log(`(Re-run with --with-steering --with-skill to also install the steering file and skill.)`);
    }
  }

  if (args.verify) {
    for (const hook of HOOK_TABLE) {
      const target = join(P.HOOKS_DIR, `openviking-${hook.event}.json`);
      const parsed = JSON.parse(readFileSync(target, "utf8"));
      if (parsed.version !== "v1") throw new Error(`verify: ${target} missing version v1`);
      if (!Array.isArray(parsed.hooks) || parsed.hooks.length !== 1) {
        throw new Error(`verify: ${target} hooks[] malformed`);
      }
      const h = parsed.hooks[0];
      if (h.trigger !== hook.trigger) throw new Error(`verify: ${target} trigger mismatch`);
      if (hook.matcher && h.matcher !== hook.matcher) {
        throw new Error(`verify: ${target} matcher mismatch`);
      }
      if (!h.action || h.action.type !== "command" || typeof h.action.command !== "string") {
        throw new Error(`verify: ${target} action malformed`);
      }
    }
    if (!args.dryRun) log(`  verify:   4 hook files well-formed (v1)`);
  }
}

main();

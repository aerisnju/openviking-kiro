#!/usr/bin/env node

/**
 * Upstream drift check and sync for openviking-kiro.
 *
 * This project copies or mirrors a few files from the official OpenViking
 * repository (volcengine/OpenViking, examples/agent-hook-plugin) and imports
 * the shared runtime that official installers put in
 * ~/.openviking/agent-integrations/memory-plugin-shared/lib. Upstream changes
 * without notice, so this tool compares against a local clone and says what to
 * re-sync or re-review. upstream.lock.json is the provenance record.
 *
 * File classes in the lock:
 *   A  verbatim copy of an upstream file (must stay byte-identical; --sync re-copies)
 *   B  adapted copy (Kiro-specific edits; a human re-reviews when upstream moves)
 *   C  independent file that mirrors an upstream pattern (same: human review)
 *
 * Usage:
 *   node scripts/check-upstream.mjs --upstream <clone> [options]
 *
 *   --upstream <path>   clone of volcengine/OpenViking (default: $OPENVIKING_UPSTREAM)
 *   --installed <path>  agent-integrations dir (default: <home>/.openviking/agent-integrations)
 *   --json              machine-readable report on stdout
 *   --sync              re-copy class A files that drifted from the upstream working tree
 *   --update-lock       after a human review, record the current upstream state as the
 *                       baseline for every file (refuses while class A is not identical)
 *   --force             with --sync: copy even if the upstream working tree is dirty for those paths
 *   --strict            class B/C changes make the exit code 1
 *   --project <path>    project root (default: the parent of scripts/; used by the tests)
 *
 * Exit code: 0 clean; 1 class A drift, a missing/broken imported symbol, a missing
 * lock or local dependency, or a refused sync; 2 usage or I/O error. Class B/C
 * changes are warnings (exit 0) unless --strict.
 *
 * Read-only toward the upstream clone: only `git` reads (GIT_OPTIONAL_LOCKS=0,
 * fsmonitor off) and file reads; it never fetches, pulls or checks out, and it
 * writes only inside the project (class A files and upstream.lock.json).
 * Zero dependencies; Node >= 18.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SCHEMA_VERSION = 1;
export const LOCK_NAME = "upstream.lock.json";
const UPSTREAM_REPO = "volcengine/OpenViking";
const PLUGIN_JSON = "examples/agent-hook-plugin/plugin.json";
const SHARED_LIB = "examples/memory-plugin-shared/lib";
const SCAN_DIRS = ["hosts", "scripts", "servers"];
const SCAN_SKIP = new Set(["check-upstream.mjs", "check-test-prereqs.mjs"]);
const DEFAULT_PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- hashing

export const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");

/** Normalize CRLF to LF byte-for-byte (latin1 round-trip keeps every other byte). */
export function lfNormalize(buf) {
  const text = buf.toString("latin1");
  return text.includes("\r\n") ? Buffer.from(text.replace(/\r\n/g, "\n"), "latin1") : buf;
}

/** The git blob id of `buf` (SHA-1 object format), without running git. */
export function blobSha(buf) {
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

// ---------------------------------------------------------------- git (read-only)

function makeGit(dir) {
  const base = ["--no-optional-locks", "-C", dir, "-c", "core.fsmonitor=false", "-c", "core.quotepath=off"];
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  return function git(args) {
    const r = spawnSync("git", [...base, ...args], { encoding: "utf8", env, windowsHide: true });
    return { ok: r.status === 0, status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", error: r.error };
  };
}

// ---------------------------------------------------------------- CLI

const USAGE = `usage: node scripts/check-upstream.mjs --upstream <clone of volcengine/OpenViking> [options]
  --upstream <path>   upstream clone (default: env OPENVIKING_UPSTREAM)
  --installed <path>  agent-integrations dir (default: <home>/.openviking/agent-integrations)
  --json              JSON report on stdout
  --sync              re-copy class A files that drifted (from the upstream working tree)
  --update-lock       record the current upstream state as the reviewed baseline
  --force             with --sync: allow a dirty upstream working tree for the copied paths
  --strict            class B/C changes exit 1
  --project <path>    project root (default: this repo)
exit: 0 clean | 1 drift / broken import / refused sync / lock problem | 2 usage or I/O error`;

export function parseArgs(argv, env = process.env) {
  const args = {
    upstream: env.OPENVIKING_UPSTREAM || "",
    installed: "",
    project: DEFAULT_PROJECT,
    json: false,
    sync: false,
    updateLock: false,
    force: false,
    strict: false,
    help: false,
  };
  const value = (i, name) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new UsageError(`${name} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--upstream") args.upstream = value(i++, a);
    else if (a === "--installed") args.installed = value(i++, a);
    else if (a === "--project") args.project = resolve(value(i++, a));
    else if (a === "--json") args.json = true;
    else if (a === "--sync") args.sync = true;
    else if (a === "--update-lock") args.updateLock = true;
    else if (a === "--force") args.force = true;
    else if (a === "--strict") args.strict = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new UsageError(`unknown option ${a}`);
  }
  if (!args.installed) args.installed = join(homedir(), ".openviking", "agent-integrations");
  return args;
}

class UsageError extends Error {}

// ---------------------------------------------------------------- project scan

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const posixRel = (from, to) => relative(from, to).split(sep).join("/");

function parseClause(clause) {
  const names = [];
  const braces = clause.match(/\{([\s\S]*)\}/);
  const rest = clause.replace(/\{[\s\S]*\}/, "");
  if (braces) {
    for (const part of braces[1].split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  if (/\*\s*as\s+[\w$]+/.test(rest)) names.push("*");
  else if (/[\w$]+/.test(rest.replace(/,/g, " "))) names.push("default");
  return names;
}

/**
 * Parse (do not hard-code) what the project imports from the shared runtime and
 * which relative imports of its own files do not resolve.
 * Returns { modules: { "<lib module>": [symbols] }, missingLocal: [{file, specifier}] }.
 */
export function scanProject(project) {
  const modules = new Map();
  const missingLocal = [];
  const add = (mod, syms) => {
    if (!modules.has(mod)) modules.set(mod, new Set());
    for (const s of syms) modules.get(mod).add(s);
  };
  const files = SCAN_DIRS.flatMap((d) => walk(join(project, d))).filter(
    (f) => f.endsWith(".mjs") && !SCAN_SKIP.has(f.split(sep).pop()),
  );
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const specs = [];
    for (const m of src.matchAll(/^[ \t]*(?:import|export)\s+([^;=()]*?)\s+from\s+["']([^"']+)["']/gm)) {
      specs.push({ clause: m[1], spec: m[2] });
    }
    for (const m of src.matchAll(/^[ \t]*import\s+["']([^"']+)["']/gm)) specs.push({ clause: "", spec: m[1] });
    for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) specs.push({ clause: "", spec: m[1] });
    for (const { clause, spec } of specs) {
      const lib = /^(?:\.\.\/)+memory-plugin-shared\/lib\/(.+)$/.exec(spec);
      if (lib) {
        add(lib[1], clause ? parseClause(clause) : []);
      } else if (spec.startsWith("./") || spec.startsWith("../")) {
        if (!existsSync(resolve(dirname(file), spec))) {
          missingLocal.push({ file: posixRel(project, file), specifier: spec });
        }
      }
    }
  }
  const sorted = Object.fromEntries(
    [...modules.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([m, s]) => [m, [...s].sort()]),
  );
  return { modules: sorted, missingLocal };
}

// ---------------------------------------------------------------- lock

function readLock(project) {
  const path = join(project, LOCK_NAME);
  if (!existsSync(path)) return { error: `${LOCK_NAME} not found in the project` };
  try {
    const lock = JSON.parse(readFileSync(path, "utf8"));
    if (lock.schemaVersion !== SCHEMA_VERSION) {
      return { error: `${LOCK_NAME}: unsupported schemaVersion ${lock.schemaVersion} (this tool reads ${SCHEMA_VERSION})` };
    }
    if (!Array.isArray(lock.files)) return { error: `${LOCK_NAME}: "files" must be an array` };
    return { lock, path };
  } catch (error) {
    return { error: `${LOCK_NAME}: ${error.message}` };
  }
}

const KEY_ORDER = [
  "path", "class", "upstreamRepo", "upstreamPath", "upstreamCommit", "upstreamCommitDate",
  "upstreamBlob", "upstreamSha256", "localSha256", "alsoWatch", "note",
];

function orderedEntry(entry) {
  const out = {};
  for (const k of KEY_ORDER) if (entry[k] !== undefined) out[k] = entry[k];
  for (const k of Object.keys(entry)) if (!(k in out)) out[k] = entry[k];
  return out;
}

function serializeLock(lock) {
  const out = { ...lock, files: lock.files.map(orderedEntry) };
  return `${JSON.stringify(out, null, 2)}\n`;
}

function writeInside(project, target, content) {
  const root = resolve(project) + sep;
  if (!resolve(target).startsWith(root)) throw new Error(`refusing to write outside the project: ${target}`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

// ---------------------------------------------------------------- checks

function commitsSince(git, fromCommit, upstreamPaths) {
  const known = fromCommit && git(["cat-file", "-e", `${fromCommit}^{commit}`]).ok;
  const range = known ? [`${fromCommit}..HEAD`] : ["-n", "5"];
  const r = git(["log", "--format=%h%x09%cs%x09%s", ...range, "--", ...upstreamPaths]);
  const commits = r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, date, ...subject] = l.split("\t");
      return { sha, date, subject: subject.join("\t") };
    });
  return { commits, baselineKnown: Boolean(known) };
}

function upstreamBytes(upstream, rel) {
  const path = join(upstream, ...rel.split("/"));
  return existsSync(path) && statSync(path).isFile() ? lfNormalize(readFileSync(path)) : null;
}

function checkFiles({ project, upstream, git, lock }) {
  const results = [];
  for (const entry of lock.files) {
    const localPath = join(project, ...entry.path.split("/"));
    const local = existsSync(localPath) ? lfNormalize(readFileSync(localPath)) : null;
    const up = upstreamBytes(upstream, entry.upstreamPath);
    const result = {
      path: entry.path,
      class: entry.class,
      upstreamPath: entry.upstreamPath,
      lockCommit: entry.upstreamCommit || null,
      status: "",
      commits: [],
      notes: [],
    };
    if (!local) {
      result.status = "LOCAL-MISSING";
    } else if (!up) {
      result.status = "UPSTREAM-MISSING";
    } else if (entry.class === "A") {
      result.status = sha256Hex(local) === sha256Hex(up) ? "IDENTICAL" : "DRIFTED";
    } else {
      const watched = [
        { upstreamPath: entry.upstreamPath, upstreamBlob: entry.upstreamBlob },
        ...(entry.alsoWatch || []),
      ];
      const changed = [];
      for (const w of watched) {
        const bytes = upstreamBytes(upstream, w.upstreamPath);
        if (!bytes) {
          changed.push(w.upstreamPath);
          result.notes.push(`watched upstream file is gone: ${w.upstreamPath}`);
        } else if (!w.upstreamBlob) {
          changed.push(w.upstreamPath);
          result.notes.push(`no reviewed baseline recorded for ${w.upstreamPath}`);
        } else if (blobSha(bytes) !== w.upstreamBlob) {
          changed.push(w.upstreamPath);
        }
      }
      result.status = changed.length ? "CHANGED" : "UNCHANGED";
      if (changed.length) {
        const since = commitsSince(git, entry.upstreamCommit, changed);
        result.commits = since.commits;
        if (!since.baselineKnown) result.notes.push("reviewed commit is not in this clone; showing the latest commits instead");
      }
    }
    if (result.status === "DRIFTED") {
      const since = commitsSince(git, entry.upstreamCommit, [entry.upstreamPath]);
      result.commits = since.commits;
      if (!since.baselineKnown) result.notes.push("synced commit is not in this clone; showing the latest commits instead");
    }
    if (local && entry.localSha256 && sha256Hex(local) !== entry.localSha256) {
      result.notes.push(`local file differs from the lock's localSha256; run --update-lock after review`);
    }
    results.push(result);
  }
  return results;
}

function walkLib(dir) {
  const out = new Map();
  for (const file of walk(dir)) out.set(posixRel(dir, file), sha256Hex(lfNormalize(readFileSync(file))));
  return out;
}

function compareLibs(upstreamLib, installedLib) {
  if (!existsSync(upstreamLib) || !existsSync(installedLib)) return null;
  const up = walkLib(upstreamLib);
  const ins = walkLib(installedLib);
  const differing = [];
  const onlyUpstream = [];
  const onlyInstalled = [];
  for (const [rel, hash] of up) {
    if (!ins.has(rel)) onlyUpstream.push(rel);
    else if (ins.get(rel) !== hash) differing.push(rel);
  }
  for (const rel of ins.keys()) if (!up.has(rel)) onlyInstalled.push(rel);
  return {
    upstreamFiles: up.size,
    installedFiles: ins.size,
    identical: up.size - differing.length - onlyUpstream.length,
    differing,
    onlyUpstream,
    onlyInstalled,
  };
}

async function verifyLib(label, libDir, modules) {
  const out = { label, found: existsSync(libDir), results: [] };
  if (!out.found) return out;
  for (const [mod, symbols] of Object.entries(modules)) {
    const file = join(libDir, ...mod.split("/"));
    if (!existsSync(file)) {
      out.results.push({ module: mod, symbol: null, status: "MODULE-MISSING" });
      continue;
    }
    let ns;
    try {
      ns = await import(pathToFileURL(file).href);
    } catch (error) {
      out.results.push({ module: mod, symbol: null, status: "MODULE-ERROR", detail: String(error?.message || error).split("\n")[0] });
      continue;
    }
    if (!symbols.length) out.results.push({ module: mod, symbol: null, status: "OK", type: "module" });
    for (const symbol of symbols) {
      if (symbol === "*") {
        out.results.push({ module: mod, symbol, status: "OK", type: "namespace" });
      } else if (!(symbol in ns)) {
        out.results.push({ module: mod, symbol, status: "MISSING" });
      } else {
        out.results.push({ module: mod, symbol, status: "OK", type: typeof ns[symbol] === "function" ? "function" : "value" });
      }
    }
  }
  return out;
}

const brokenIn = (lib) => (lib?.results || []).filter((r) => r.status !== "OK");

// ---------------------------------------------------------------- actions

function doSync({ project, upstream, git, lock, results, force, report }) {
  const drifted = results.filter((r) => r.class === "A" && (r.status === "DRIFTED" || r.status === "LOCAL-MISSING"));
  report.sync = { requested: true, copied: [], refused: false };
  if (!drifted.length) return false;
  const dirty = drifted.filter((r) => git(["status", "--porcelain", "--untracked-files=no", "--", r.upstreamPath]).stdout.trim());
  if (dirty.length && !force) {
    report.sync.refused = true;
    report.errors.push(
      `sync refused: the upstream working tree has uncommitted changes in ${dirty.map((r) => r.upstreamPath).join(", ")} (commit or stash them there, or pass --force)`,
    );
    return false;
  }
  const head = git(["rev-parse", "HEAD"]).stdout.trim();
  const headDate = git(["log", "-1", "--format=%cI", "HEAD"]).stdout.trim();
  for (const r of drifted) {
    const bytes = upstreamBytes(upstream, r.upstreamPath);
    if (!bytes) {
      report.errors.push(`sync: upstream file is gone: ${r.upstreamPath}`);
      continue;
    }
    writeInside(project, join(project, ...r.path.split("/")), bytes);
    const entry = lock.files.find((e) => e.path === r.path);
    Object.assign(entry, {
      upstreamCommit: head,
      upstreamCommitDate: headDate,
      upstreamBlob: blobSha(bytes),
      upstreamSha256: sha256Hex(bytes),
      localSha256: sha256Hex(bytes),
    });
    report.sync.copied.push(r.path);
  }
  writeInside(project, join(project, LOCK_NAME), serializeLock(lock));
  return true;
}

function doUpdateLock({ project, upstream, git, lock, scan, report }) {
  const head = git(["rev-parse", "HEAD"]).stdout.trim();
  const headDate = git(["log", "-1", "--format=%cI", "HEAD"]).stdout.trim();
  const problems = [];
  for (const entry of lock.files) {
    const local = existsSync(join(project, ...entry.path.split("/"))) ? lfNormalize(readFileSync(join(project, ...entry.path.split("/")))) : null;
    const up = upstreamBytes(upstream, entry.upstreamPath);
    if (!local) problems.push(`${entry.path}: local file is missing`);
    else if (!up) problems.push(`${entry.path}: upstream file is gone (${entry.upstreamPath})`);
    else if (entry.class === "A" && sha256Hex(local) !== sha256Hex(up)) problems.push(`${entry.path}: class A is not identical to upstream; run --sync first`);
  }
  if (problems.length) {
    report.errors.push(`update-lock refused: ${problems.join("; ")}`);
    return false;
  }
  for (const entry of lock.files) {
    const local = lfNormalize(readFileSync(join(project, ...entry.path.split("/"))));
    const up = upstreamBytes(upstream, entry.upstreamPath);
    entry.upstreamRepo = UPSTREAM_REPO;
    entry.upstreamCommit = head;
    entry.upstreamCommitDate = headDate;
    entry.upstreamBlob = blobSha(up);
    entry.localSha256 = sha256Hex(local);
    if (entry.class === "A") entry.upstreamSha256 = sha256Hex(up);
    else delete entry.upstreamSha256;
    if (entry.alsoWatch) {
      entry.alsoWatch = entry.alsoWatch.map((w) => {
        const bytes = upstreamBytes(upstream, w.upstreamPath);
        return { upstreamPath: w.upstreamPath, upstreamBlob: bytes ? blobSha(bytes) : w.upstreamBlob };
      });
    }
  }
  let pluginVersion = lock.upstream?.pluginVersion || "";
  const pj = upstreamBytes(upstream, PLUGIN_JSON);
  if (pj) {
    try { pluginVersion = JSON.parse(pj.toString("utf8")).version || pluginVersion; } catch { /* keep */ }
  }
  lock.upstream = { repo: UPSTREAM_REPO, commit: head, commitDate: headDate, pluginVersion };
  lock.sharedLibImports = scan.modules;
  writeInside(project, join(project, LOCK_NAME), serializeLock(lock));
  report.updateLock = { updated: true, commit: head, pluginVersion };
  return true;
}

// ---------------------------------------------------------------- run

export async function run(argv, env = process.env) {
  const args = parseArgs(argv, env);
  const report = {
    tool: "check-upstream",
    schemaVersion: SCHEMA_VERSION,
    upstream: null,
    files: [],
    localDependencies: [],
    imports: null,
    libCompare: null,
    sync: { requested: false },
    updateLock: { requested: args.updateLock },
    warnings: [],
    errors: [],
    exitCode: 0,
  };
  if (args.help) return { args, report, help: true };
  if (!args.upstream) throw new UsageError("--upstream <clone of volcengine/OpenViking> is required (or set OPENVIKING_UPSTREAM)");
  const upstream = resolve(args.upstream);
  if (!existsSync(upstream) || !statSync(upstream).isDirectory()) throw new UsageError(`upstream path is not a directory: ${upstream}`);
  const git = makeGit(upstream);
  const inside = git(["rev-parse", "--is-inside-work-tree"]);
  if (inside.error?.code === "ENOENT") throw new UsageError("git is not installed or not on PATH");
  if (!inside.ok || inside.stdout.trim() !== "true") throw new UsageError(`upstream path is not a git working tree: ${upstream}`);
  if (!existsSync(join(upstream, ...PLUGIN_JSON.split("/")))) {
    throw new UsageError(`${upstream} does not look like volcengine/OpenViking (missing ${PLUGIN_JSON})`);
  }
  if (!existsSync(args.project)) throw new UsageError(`project path does not exist: ${args.project}`);

  const loaded = readLock(args.project);
  if (loaded.error) {
    report.errors.push(loaded.error);
    report.exitCode = 1;
    return { args, report };
  }
  const lock = loaded.lock;
  const scan = scanProject(args.project);

  // Actions first, so the report below describes the resulting state.
  let results = checkFiles({ project: args.project, upstream, git, lock });
  if (args.sync) {
    if (doSync({ project: args.project, upstream, git, lock, results, force: args.force, report })) {
      results = checkFiles({ project: args.project, upstream, git, lock });
    }
  }
  if (args.updateLock && !report.errors.length) {
    if (doUpdateLock({ project: args.project, upstream, git, lock, scan, report })) {
      results = checkFiles({ project: args.project, upstream, git, lock });
    }
  }

  const head = git(["rev-parse", "HEAD"]).stdout.trim();
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]).stdout.trim().length > 0;
  let upstreamVersion = "";
  try {
    upstreamVersion = JSON.parse(readFileSync(join(upstream, ...PLUGIN_JSON.split("/")), "utf8")).version || "";
  } catch { /* reported as unknown */ }
  const kiro = git(["grep", "-il", "kiro"]);
  const kiroFiles = kiro.ok ? kiro.stdout.split("\n").filter(Boolean) : [];
  report.upstream = {
    head,
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim(),
    commitDate: git(["log", "-1", "--format=%cI", "HEAD"]).stdout.trim(),
    dirty,
    lockCommit: lock.upstream?.commit || null,
    lockPluginVersion: lock.upstream?.pluginVersion || null,
    pluginVersion: upstreamVersion,
    pluginVersionChanged: Boolean(upstreamVersion && lock.upstream?.pluginVersion && upstreamVersion !== lock.upstream.pluginVersion),
    mentionsKiro: { count: kiroFiles.length, files: kiroFiles.slice(0, 20) },
  };
  report.files = results;
  report.localDependencies = scan.missingLocal;

  // Imported symbols, verified against the upstream clone and the installed runtime.
  const upstreamLib = join(upstream, ...SHARED_LIB.split("/"));
  const installedLib = join(resolve(args.installed), "memory-plugin-shared", "lib");
  const upstreamCheck = await verifyLib("upstream", upstreamLib, scan.modules);
  const installedCheck = await verifyLib("installed", installedLib, scan.modules);
  const lockedImports = lock.sharedLibImports || {};
  const importDelta = [];
  for (const [mod, syms] of Object.entries(scan.modules)) {
    for (const s of syms) if (!(lockedImports[mod] || []).includes(s)) importDelta.push(`${mod}:${s}`);
  }
  report.imports = {
    modules: scan.modules,
    symbolCount: Object.values(scan.modules).reduce((n, s) => n + s.length, 0),
    notInLock: importDelta,
    upstream: upstreamCheck,
    installed: installedCheck,
  };
  report.libCompare = compareLibs(upstreamLib, installedLib);

  // Warnings and errors.
  for (const r of results) {
    if (r.class === "A" && r.status !== "IDENTICAL") report.errors.push(`class A ${r.path}: ${r.status}`);
    if (r.class !== "A" && r.status === "CHANGED") report.warnings.push(`class ${r.class} ${r.path}: upstream changed since it was last reviewed`);
    if (r.class !== "A" && (r.status === "UPSTREAM-MISSING" || r.status === "LOCAL-MISSING")) report.errors.push(`class ${r.class} ${r.path}: ${r.status}`);
  }
  for (const d of scan.missingLocal) report.errors.push(`${d.file} imports ${d.specifier}, which does not exist locally (a new upstream sibling? add it to ${LOCK_NAME} as class A and copy it)`);
  if (!upstreamCheck.found) report.errors.push(`upstream shared lib not found at ${SHARED_LIB}`);
  for (const b of brokenIn(upstreamCheck)) report.errors.push(`BREAKING upstream lib: ${b.module}${b.symbol ? ` ${b.symbol}` : ""} ${b.status}${b.detail ? ` (${b.detail})` : ""}`);
  if (!installedCheck.found) report.warnings.push(`installed shared lib not found (${installedLib}); import check skipped for it`);
  for (const b of brokenIn(installedCheck)) report.errors.push(`BREAKING installed lib: ${b.module}${b.symbol ? ` ${b.symbol}` : ""} ${b.status}${b.detail ? ` (${b.detail})` : ""}`);
  if (importDelta.length) report.warnings.push(`imports not recorded in the lock: ${importDelta.join(", ")} (run --update-lock after review)`);
  if (report.upstream.pluginVersionChanged) report.warnings.push(`upstream plugin version ${upstreamVersion} differs from the lock (${lock.upstream.pluginVersion})`);
  if (dirty) report.warnings.push("the upstream working tree has uncommitted changes; results describe that working tree");
  if (kiroFiles.length) report.warnings.push(`upstream now mentions "kiro" in ${kiroFiles.length} tracked file(s): check whether official support exists`);
  if (report.libCompare && (report.libCompare.differing.length || report.libCompare.onlyUpstream.length || report.libCompare.onlyInstalled.length)) {
    report.warnings.push("installed shared lib differs from the upstream clone (version skew); re-run an official installer to update it");
  }
  if (args.strict) {
    for (const r of results) if (r.class !== "A" && r.status === "CHANGED") report.errors.push(`strict: class ${r.class} ${r.path} changed upstream`);
  }
  report.exitCode = report.errors.length ? 1 : 0;
  return { args, report };
}

// ---------------------------------------------------------------- output

export function renderText(report) {
  const out = [];
  const u = report.upstream;
  out.push("openviking-kiro: upstream check");
  if (u) {
    out.push(`  upstream  HEAD ${u.head.slice(0, 12)} (${u.branch}) ${u.commitDate}  ${u.dirty ? "DIRTY working tree" : "clean"}`);
    out.push(`  plugin    upstream ${u.pluginVersion || "?"}  lock ${u.lockPluginVersion || "?"}  ${u.pluginVersionChanged ? "CHANGED" : "same"}`);
    out.push(`  kiro      upstream mentions kiro in ${u.mentionsKiro.count} tracked file(s)`);
  }
  for (const cls of ["A", "B", "C"]) {
    const rows = report.files.filter((f) => f.class === cls);
    if (!rows.length) continue;
    out.push("");
    out.push(cls === "A" ? "Class A: verbatim copies" : cls === "B" ? "Class B: adapted copies (human review when CHANGED)" : "Class C: pattern-mirrored (human review when CHANGED)");
    for (const f of rows) {
      out.push(`  ${f.status.padEnd(16)} ${f.path}  <- ${f.upstreamPath}`);
      for (const c of f.commits) out.push(`      ${c.sha} ${c.date} ${c.subject}`);
      for (const n of f.notes) out.push(`      note: ${n}`);
    }
  }
  if (report.sync.requested) {
    out.push("");
    out.push(`Sync: ${report.sync.refused ? "REFUSED" : report.sync.copied.length ? `copied ${report.sync.copied.join(", ")}` : "nothing to copy"}`);
  }
  if (report.updateLock.updated) out.push(`Lock: baseline updated to ${report.updateLock.commit.slice(0, 12)} (plugin ${report.updateLock.pluginVersion})`);
  if (report.imports) {
    out.push("");
    out.push(`Imports from the shared runtime: ${report.imports.symbolCount} symbol(s) in ${Object.keys(report.imports.modules).length} module(s) (parsed from source)`);
    for (const lib of [report.imports.upstream, report.imports.installed]) {
      if (!lib.found) { out.push(`  ${lib.label.padEnd(10)} lib not found, skipped`); continue; }
      const bad = brokenIn(lib);
      out.push(`  ${lib.label.padEnd(10)} ${bad.length ? `${bad.length} BREAKING` : `all ${lib.results.length} present`}`);
      for (const b of bad) out.push(`      ${b.status} ${b.module}${b.symbol ? ` ${b.symbol}` : ""}${b.detail ? ` (${b.detail})` : ""}`);
    }
  }
  if (report.libCompare) {
    const c = report.libCompare;
    out.push(`  installed vs upstream lib: ${c.identical}/${c.upstreamFiles} files identical, ${c.differing.length} differ, ${c.onlyUpstream.length} only upstream, ${c.onlyInstalled.length} only installed`);
  }
  if (report.warnings.length) { out.push(""); out.push("Warnings:"); for (const w of report.warnings) out.push(`  - ${w}`); }
  if (report.errors.length) { out.push(""); out.push("Errors:"); for (const e of report.errors) out.push(`  - ${e}`); }
  out.push("");
  out.push(`Result: ${report.exitCode === 0 ? "OK" : "PROBLEMS FOUND"} (exit ${report.exitCode})`);
  return out.join("\n");
}

async function main() {
  let outcome;
  try {
    outcome = await run(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`check-upstream: ${error.message}\n${USAGE}\n`);
      return 2;
    }
    process.stderr.write(`check-upstream: ${error?.stack || error}\n`);
    return 2;
  }
  if (outcome.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const { args, report } = outcome;
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderText(report)}\n`);
  return report.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => process.exit(code));
}

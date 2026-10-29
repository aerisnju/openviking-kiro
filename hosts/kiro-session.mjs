/**
 * Kiro session-directory locator.
 *
 * Kiro nests each session's transcript under an opaque parent:
 *   ~/.kiro/sessions/<shortId>/<sessId>/messages.jsonl
 * The <sessId> dir segment is build-dependent — a bare UUID on some builds,
 * `sess_<uuid>` on others (both occur live) — so every comparison strips a
 * leading `sess_` from BOTH sides before matching (Finding 1).
 *
 * Resolution order:
 *   1. PRIMARY (glob)      — scan sessions/<shortId>/ for a child matching the id.
 *   2. SECONDARY (index)   — scan session-index/*.jsonl for the latest `add`.
 *   3. TERTIARY (mtime)    — ONLY when no session id resolved: newest transcript.
 * Present-but-unmatched (id given, nothing found) → "" (fail closed) + one
 * visible log line per session (Finding 3). All fs wrapped → "" on failure.
 * Never reuses Kiro's own publish.cursor.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function kiroHome() {
  return process.env.KIRO_HOME || join(homedir(), ".kiro");
}

const stripSess = (s) => String(s || "").replace(/^sess_/, "");

function readSessId(input = {}) {
  return String(
    input.session_id || input.sessionId || process.env.KIRO_SESSION_ID || "",
  ).trim();
}

function fromGlob(sessionsRoot, want) {
  let shortIds;
  try {
    shortIds = readdirSync(sessionsRoot);
  } catch {
    return "";
  }
  for (const shortId of shortIds) {
    const shortDir = join(sessionsRoot, shortId);
    let children;
    try {
      children = readdirSync(shortDir);
    } catch {
      continue;
    }
    for (const child of children) {
      if (stripSess(child) !== want) continue;
      const candidate = join(shortDir, child, "messages.jsonl");
      if (existsSync(candidate)) return candidate;
    }
  }
  return "";
}

function fromIndex(home, want) {
  const indexRoot = join(home, "session-index");
  let files;
  try {
    files = readdirSync(indexRoot);
  } catch {
    return "";
  }
  let best = null;
  let bestAt = -Infinity;
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    let raw;
    try {
      raw = readFileSync(join(indexRoot, file), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.op !== "add" || typeof row.sessionPath !== "string") continue;
      const seg = row.sessionPath.split("/").pop();
      if (stripSess(seg) !== want) continue;
      const at = Number(row.at || 0);
      if (at >= bestAt) {
        bestAt = at;
        best = row.sessionPath;
      }
    }
  }
  if (!best) return "";
  const candidate = join(home, "sessions", best, "messages.jsonl");
  return existsSync(candidate) ? candidate : "";
}

function newestByMtime(sessionsRoot) {
  let shortIds;
  try {
    shortIds = readdirSync(sessionsRoot);
  } catch {
    return "";
  }
  let best = "";
  let bestMtime = -Infinity;
  for (const shortId of shortIds) {
    const shortDir = join(sessionsRoot, shortId);
    let children;
    try {
      children = readdirSync(shortDir);
    } catch {
      continue;
    }
    for (const child of children) {
      const candidate = join(shortDir, child, "messages.jsonl");
      let st;
      try {
        st = statSync(candidate);
      } catch {
        continue;
      }
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        best = candidate;
      }
    }
  }
  return best;
}

/**
 * Resolve the absolute messages.jsonl path for a hook input, or "".
 *
 * @param {object} input hook stdin payload (session_id / sessionId) — env
 *   KIRO_SESSION_ID is consulted as a fallback.
 * @param {string} home  Kiro home dir (defaults to kiroHome()).
 * @param {object} [opts]
 * @param {(level:string,msg:string)=>void} [opts.log] visible logger for the
 *   present-but-unmatched diagnostic.
 * @param {{loggedUnresolved?:boolean}} [opts.state] carries the once-per-session
 *   dedup flag; the caller persists `state.loggedUnresolved` across Stops.
 */
export function resolveKiroMessagesPath(input = {}, home = kiroHome(), opts = {}) {
  const sessId = readSessId(input);
  const sessionsRoot = join(home, "sessions");

  if (!sessId) {
    // No id at all — tertiary mtime last resort keeps capture alive.
    return newestByMtime(sessionsRoot);
  }

  const want = stripSess(sessId);
  const viaGlob = fromGlob(sessionsRoot, want);
  if (viaGlob) return viaGlob;
  const viaIndex = fromIndex(home, want);
  if (viaIndex) return viaIndex;

  // Present-but-unmatched: fail closed, but say so once per session.
  const state = opts.state;
  const alreadyLogged = state && state.loggedUnresolved;
  if (!alreadyLogged && typeof opts.log === "function") {
    opts.log(
      "warn",
      `openviking: session ${sessId} present but no messages.jsonl matched under sessions/*/; capture disabled for this session`,
    );
    if (state) state.loggedUnresolved = true;
  }
  return "";
}

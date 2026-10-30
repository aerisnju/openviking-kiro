import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { makeTmp } from "./helpers/tmp.mjs";

import { resolveKiroMessagesPath, kiroHome } from "../hosts/kiro-session.mjs";

function tempHome() {
  return makeTmp("sess");
}

function seedSession(home, shortId, sessDir) {
  const dir = join(home, "sessions", shortId, sessDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "messages.jsonl");
  writeFileSync(path, "");
  return path;
}

function seedIndex(home, shortId, sessionPath, at = 1000) {
  const dir = join(home, "session-index");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${shortId}.jsonl`),
    JSON.stringify({ op: "add", sessionPath, at }) + "\n",
  );
}

test("kiroHome honors KIRO_HOME", () => {
  const prev = process.env.KIRO_HOME;
  process.env.KIRO_HOME = "X:/kiro-home";
  try {
    assert.equal(kiroHome(), "X:/kiro-home");
  } finally {
    if (prev === undefined) delete process.env.KIRO_HOME;
    else process.env.KIRO_HOME = prev;
  }
});

test("glob primary: matches an exact-shape session dir", () => {
  const home = tempHome();
  const want = seedSession(home, "shortA", "abcd-1111");
  assert.equal(resolveKiroMessagesPath({ session_id: "abcd-1111" }, home), want);
});

test("index secondary: resolves via the index when the glob one-level scan misses", () => {
  const home = tempHome();
  // Transcript nested two levels below shortId. The glob scans only the direct
  // children of sessions/shortI ("nested"), which does not normalize to the
  // queried id ("deeper"), so the primary misses. The index sessionPath's last
  // segment ("deeper") matches, so the secondary resolves it.
  const dir = join(home, "sessions", "shortI", "nested", "deeper");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "messages.jsonl");
  writeFileSync(path, "");
  seedIndex(home, "shortI", "shortI/nested/deeper");
  assert.equal(resolveKiroMessagesPath({ session_id: "deeper" }, home), path);
});

test("prefix tolerance — glob: bare-UUID id matches sess_-prefixed dir", () => {
  const home = tempHome();
  const want = seedSession(home, "shortA", "sess_uuidA");
  assert.equal(resolveKiroMessagesPath({ session_id: "uuidA" }, home), want);
});

test("prefix tolerance — glob: sess_-prefixed id matches bare dir", () => {
  const home = tempHome();
  const want = seedSession(home, "shortB", "uuidB");
  assert.equal(resolveKiroMessagesPath({ session_id: "sess_uuidB" }, home), want);
});

test("prefix tolerance — index: bare id matches sess_-prefixed index segment (glob miss via nesting)", () => {
  const home = tempHome();
  // Nest so the glob one-level scan misses; the index's sess_-prefixed last
  // segment must normalize-match the bare queried id.
  const dir = join(home, "sessions", "shortC", "nested", "sess_uuidC");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "messages.jsonl");
  writeFileSync(path, "");
  seedIndex(home, "shortC", "shortC/nested/sess_uuidC");
  assert.equal(resolveKiroMessagesPath({ session_id: "uuidC" }, home), path);
});

test("prefix tolerance — index: sess_ id matches bare index segment (glob miss via nesting)", () => {
  const home = tempHome();
  const dir = join(home, "sessions", "shortD", "nested", "uuidD");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "messages.jsonl");
  writeFileSync(path, "");
  seedIndex(home, "shortD", "shortD/nested/uuidD");
  assert.equal(resolveKiroMessagesPath({ session_id: "sess_uuidD" }, home), path);
});

test("present-but-unmatched: returns '' and logs once per session", () => {
  const home = tempHome();
  mkdirSync(join(home, "sessions", "shortZ", "someone-else"), { recursive: true });
  writeFileSync(join(home, "sessions", "shortZ", "someone-else", "messages.jsonl"), "");
  const logs = [];
  const state = {};
  const log = (level, msg) => logs.push({ level, msg });

  const first = resolveKiroMessagesPath({ session_id: "sess_unknown" }, home, { log, state });
  assert.equal(first, "");
  assert.equal(logs.length, 1);
  assert.match(logs[0].msg, /present but no messages\.jsonl matched/);
  assert.equal(state.loggedUnresolved, true);

  const second = resolveKiroMessagesPath({ session_id: "sess_unknown" }, home, { log, state });
  assert.equal(second, "");
  assert.equal(logs.length, 1, "no re-log for the same unresolved session");
});

test("missing: unknown session id → ''", () => {
  const home = tempHome();
  mkdirSync(join(home, "sessions"), { recursive: true });
  assert.equal(resolveKiroMessagesPath({ session_id: "nope" }, home), "");
});

test("isolation: two sessions in different shortId dirs resolve to their own files", () => {
  const home = tempHome();
  const a = seedSession(home, "s1", "aaaa");
  const b = seedSession(home, "s2", "bbbb");
  assert.equal(resolveKiroMessagesPath({ session_id: "aaaa" }, home), a);
  assert.equal(resolveKiroMessagesPath({ session_id: "bbbb" }, home), b);
});

test("empty sessId falls back to newest messages.jsonl by mtime", async () => {
  const { utimesSync } = await import("node:fs");
  const prev = process.env.KIRO_SESSION_ID;
  delete process.env.KIRO_SESSION_ID; // no id from stdin or env → tertiary path
  try {
    const home = tempHome();
    const older = seedSession(home, "s1", "old");
    const newer = seedSession(home, "s2", "new");
    utimesSync(older, new Date(1_000_000), new Date(1_000_000));
    utimesSync(newer, new Date(2_000_000), new Date(2_000_000));
    assert.equal(resolveKiroMessagesPath({}, home), newer);
  } finally {
    if (prev === undefined) delete process.env.KIRO_SESSION_ID;
    else process.env.KIRO_SESSION_ID = prev;
  }
});

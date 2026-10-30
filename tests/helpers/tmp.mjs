/**
 * Temp-dir helper for the test suite. Every directory is created under the OS
 * temp dir with an `ov-kiro-` prefix and removed when the test process exits,
 * so a run leaves nothing behind. Removal is guarded: only a path that is
 * inside the OS temp dir and whose last segment starts with `ov-kiro-` is ever
 * deleted.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const made = new Set();

export function makeTmp(label) {
  const dir = mkdtempSync(join(tmpdir(), `ov-kiro-${label}-`));
  made.add(dir);
  return dir;
}

export function removeTmp(dir) {
  made.delete(dir);
  try {
    const root = realpathSync(tmpdir());
    const parent = realpathSync(dirname(dir));
    if (parent === root && basename(dir).startsWith("ov-kiro-")) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  } catch {
    // already gone, or not ours to delete
  }
}

export function cleanupAllTmp() {
  for (const dir of [...made]) removeTmp(dir);
}

process.on("exit", cleanupAllTmp);

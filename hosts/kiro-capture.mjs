import {
  applyIncrementalCaptureResult,
  buildIncrementalCapturePlan,
  turnDedupKey,
} from "./incremental-turn-capture.mjs";
import { cleanKiroText } from "./kiro-turns.mjs";

export const kiroTurnDedupKey = turnDedupKey;

export function buildKiroCapturePlan(turns, state = {}, cfg = {}) {
  return buildIncrementalCapturePlan(turns, state, cfg);
}

export function applyKiroCaptureResult(state, plan, result) {
  return applyIncrementalCaptureResult(state, plan, result, cleanKiroText);
}

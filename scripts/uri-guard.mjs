#!/usr/bin/env node

import { runUriGuardHook } from "../../memory-plugin-shared/lib/uri-guard.mjs";
import { HOSTS } from "../hosts/index.mjs";

// Adapted from upstream scripts/uri-guard.mjs (see upstream.lock.json). Kiro
// deltas: the client id is argv[3] because the rendered hook command is
// `uri-guard.mjs pre-tool-use kiro` (event first, like hook.mjs), and it
// defaults to "kiro". An unknown id means "no opinion", as upstream does.
export function evaluateHostUriGuard(clientId, input = {}) {
  return HOSTS[clientId] ? HOSTS[clientId].guard(input) : {};
}

const clientId = process.argv[3] || process.env.OPENVIKING_HOOK_SOURCE || "kiro";
runUriGuardHook(import.meta.url, (input) => evaluateHostUriGuard(clientId, input));

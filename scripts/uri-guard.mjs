#!/usr/bin/env node

import { runUriGuardHook } from "../../memory-plugin-shared/lib/uri-guard.mjs";
import { HOSTS } from "../hosts/index.mjs";

const clientId = process.argv[3] || process.env.OPENVIKING_HOOK_SOURCE || "kiro";
runUriGuardHook(import.meta.url, (input) => HOSTS[clientId].guard(input));

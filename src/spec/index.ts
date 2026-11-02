/**
 * Learned site specs: the `graber-web` capability, inside the browser MCP.
 *
 * A spec is a site's data format learned once (URL template + regex picks) and
 * replayed cheaply: plain HTTP when the site allows it, or the user's own
 * authenticated Chrome through this same server when the site is
 * login/Cloudflare-walled. The engine is a faithful port of the skill's Python
 * caller, so the spec files themselves are unchanged and both callers can read
 * the same JSON.
 */

export { checkMissing, decodeValue, extractBrowserText, extractHtml, extractJson, fill, getPath, normalisePick, pickValue } from './pick.js';
export { compileSpecPattern, matchAll, SpecPatternError, translatePattern } from './regex.js';
export { fetchText, DEFAULT_USER_AGENT } from './http.js';
export { createSpecStore, SpecError } from './store.js';
export type { SpecErrorCode, SpecOpSummary, SpecStore, SpecSummary } from './store.js';
export { runSpecCheck, runSpecOp } from './run.js';
export type { SpecCheckOutcome, SpecRunDeps } from './run.js';
export type {
  CheckResult,
  OpResult,
  RawSpecPick,
  SiteSpec,
  SpecCheck,
  SpecDecode,
  SpecOp,
  SpecParam,
  SpecPick,
  SpecResponse,
  SpecRow,
} from './types.js';

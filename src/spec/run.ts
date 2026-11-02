/**
 * Runs one learned site op.
 *
 * Two transports, one contract (the same `{ok, status, ms, data, error}` shape
 * the Python caller produced):
 *   - `http` (default): plain fetch, no browser;
 *   - `browser-mcp`: an op that needs the user's authenticated visible Chrome
 *     (login/Cloudflare-walled sites). Inside the MCP server this is a direct
 *     adapter call — the same tools a client would drive by hand, minus the
 *     JSON-RPC round trip to ourselves, and without ever touching a tab the op
 *     is not allowed to reuse.
 */

import { readFile } from 'node:fs/promises';
import type { BrowserAdapter, OperationOptions } from '../browser/adapter.js';
import { BrowserAdapterError } from '../browser/adapter.js';
import type { Logger } from 'pino';
import type { DomainPolicy } from '../policy/domains.js';
import { fetchText } from './http.js';
import { checkMissing, extractBrowserText, extractHtml, extractJson, fill } from './pick.js';
import { SpecError } from './store.js';
import type { CheckResult, OpResult, SiteSpec, SpecOp } from './types.js';

export interface SpecRunDeps {
  readonly adapter?: BrowserAdapter;
  readonly domainPolicy?: DomainPolicy;
  readonly logger?: Logger;
  /** Cap on a kept HTTP body; a page becomes a tool result, so it is bounded. */
  readonly maxHttpChars?: number;
  /** Upper bound on a spec's own `timeout` (seconds). */
  readonly maxHttpTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

const DEFAULT_HTTP_CHARS = 2_000_000;
const DEFAULT_MAX_HTTP_TIMEOUT_MS = 60_000;
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 1;
const DEFAULT_RETRY_WAIT_MS = 5_000;
const DEFAULT_SETTLE_SECONDS = 1.2;
const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
/** URL markers of a sign-in wall (a deliberate redirect, not an empty page). */
const LOGIN_MARKERS = ['/account/login', '/login', '/signin', '/sign-in', '/connexion'];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Where the tab ended up; null when the adapter will not say (never fatal). */
async function currentPageUrl(
  adapter: BrowserAdapter,
  pageId: string,
  options: OperationOptions,
): Promise<string | null> {
  try {
    const pages = await adapter.listPages(options);
    return pages.find((page) => page.pageId === pageId)?.url ?? null;
  } catch {
    return null;
  }
}

function pickOp(spec: SiteSpec, opName: string): SpecOp {
  const op = spec.ops[opName];
  if (op === undefined) {
    const available = Object.keys(spec.ops).join(', ') || '(none)';
    throw new SpecError('spec_unknown_op', `spec "${spec.name}" has no op "${opName}"; available: ${available}`);
  }
  return op;
}

function operationOptions(signal: AbortSignal | undefined): OperationOptions {
  return signal === undefined ? {} : { signal };
}

/**
 * `transport: browser-mcp`. Reuses a tab whose URL contains `tab_match` (that
 * tab belongs to this workflow by contract), otherwise opens a NEW tab — the
 * user's own tabs are never navigated. Extraction is visible text only.
 */
async function runOpInBrowser(
  op: SpecOp,
  params: Readonly<Record<string, string>>,
  deps: SpecRunDeps,
): Promise<unknown> {
  const adapter = deps.adapter;
  if (adapter === undefined) {
    throw new SpecError('spec_invalid', 'browser-mcp transport requires the browser adapter');
  }
  if (!adapter.isConnected()) {
    // Same typed error the page_* tools raise: the model already knows to call
    // browser_connect, and `not_connected` is flagged retryable.
    throw new BrowserAdapterError(
      'not_connected',
      'browser-mcp transport needs a connected Chrome: call browser_connect first',
    );
  }
  if (op.url === undefined) {
    throw new SpecError('spec_invalid', 'browser-mcp op needs a "url"');
  }
  const url = fill(op.url, params);
  const options = operationOptions(deps.signal);
  const token = op.tab_match ?? (op.tab_match_url !== undefined ? fill(op.tab_match_url, params) : undefined);

  const pages = await adapter.listPages(options);
  const reusable =
    token === undefined || token === ''
      ? undefined
      : pages.find((page) => (page.url ?? '').includes(token));

  let pageId: string;
  if (reusable !== undefined) {
    await adapter.navigate({ pageId: reusable.pageId, url, waitUntil: 'domcontentloaded', ...options });
    pageId = reusable.pageId;
  } else {
    const opened = await adapter.openPage({ url, ...options });
    pageId = opened.pageId;
  }

  const settleSeconds = op.settle ?? DEFAULT_SETTLE_SECONDS;
  if (settleSeconds > 0) await sleep(settleSeconds * 1000);

  if (op.wait_selector !== undefined) {
    try {
      await adapter.wait({
        pageId,
        locator: { kind: 'css', selector: op.wait_selector },
        state: 'visible',
        timeoutMs: op.wait_timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS,
        ...options,
      });
    } catch {
      // An empty result page is a valid outcome: the caller decides via `check`.
    }
  }

  // An auth wall is NOT an empty result: say so instead of reporting 0 rows as
  // if the site were fine (the user can finish the login in the visible Chrome).
  const landed = await currentPageUrl(adapter, pageId, options);
  const wall = landed === null ? undefined : LOGIN_MARKERS.find((marker) => landed.includes(marker));
  if (landed !== null && wall !== undefined && !url.includes(wall)) {
    throw new SpecExtractError(
      `the site redirected to ${landed}: the visible Chrome is not signed in for ${new URL(landed).host}. Sign in there, then retry (the tab stays open for you).`,
    );
  }

  const response = op.response ?? {};
  if (op.item_selector !== undefined) {
    const extracted = await adapter.extract({
      pageId,
      locator: { kind: 'css', selector: op.item_selector },
      ...options,
    });
    // An empty item_pattern is what puts the ported extractor in list mode.
    return extractBrowserText(extracted.items, { ...response, item_pattern: response.item_pattern ?? '' }, params);
  }
  const selector = op.text_selector ?? 'body';
  const extracted = await adapter.extract({
    pageId,
    locator: { kind: 'css', selector },
    ...options,
  });
  return extractBrowserText(extracted.items, response, params);
}

/** HTTP-level failure: the request answered (or did not) but is not usable. */
export class SpecHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'SpecHttpError';
    this.status = status;
  }
}

/** The response arrived but the spec's extraction did not yield data. */
export class SpecExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecExtractError';
  }
}

function extractWith(format: string, body: string, op: SpecOp, params: Readonly<Record<string, string>>): unknown {
  const specResponse = op.response ?? {};
  if (format === 'json') return extractJson(body, specResponse, params);
  if (format === 'embedded-json') {
    const pattern = fill(specResponse.extract ?? '', params);
    const match = new RegExp(pattern, 's').exec(body);
    const blob = match === null ? body : (match[1] ?? match[0]);
    return extractJson(
      blob,
      {
        ...(specResponse.pick !== undefined ? { pick: specResponse.pick } : {}),
        ...(specResponse.multi !== undefined ? { multi: specResponse.multi } : {}),
      },
      params,
    );
  }
  if (format === 'html') return extractHtml(body, specResponse, params);
  throw new SpecError('spec_invalid', `unknown response.format ${format}`);
}

async function runOpOverHttp(
  op: SpecOp,
  params: Readonly<Record<string, string>>,
  deps: SpecRunDeps,
): Promise<{ status: number; data: unknown }> {
  const url = fill(op.url ?? '', params);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(op.headers ?? {})) headers[key] = fill(value, params);
  if (op.cookies_file !== undefined && op.cookies_file !== '') {
    try {
      // The spec only ever holds a PATH; the cookie value stays on disk.
      headers['Cookie'] = (await readFile(op.cookies_file, 'utf8')).trim();
    } catch (error) {
      throw new SpecError('spec_invalid', `cookies_file unreadable: ${(error as Error).message}`);
    }
  }
  const timeoutMs = Math.min(
    (op.timeout ?? DEFAULT_HTTP_TIMEOUT_MS / 1000) * 1000,
    deps.maxHttpTimeoutMs ?? DEFAULT_MAX_HTTP_TIMEOUT_MS,
  );
  const response = await fetchText({
    url,
    method: op.method ?? 'GET',
    headers,
    body: op.body ?? null,
    timeoutMs,
    retries: op.retries ?? DEFAULT_RETRIES,
    retryWaitMs: (op.retry_wait ?? DEFAULT_RETRY_WAIT_MS / 1000) * 1000,
    maxChars: deps.maxHttpChars ?? DEFAULT_HTTP_CHARS,
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
  });
  if (response.status === 0) {
    throw new SpecHttpError(0, `no HTTP response: ${response.text}`);
  }
  if (response.status >= 400) {
    throw new SpecHttpError(response.status, `HTTP ${response.status} (body ${response.text.length} chars)`);
  }
  try {
    return { status: response.status, data: extractWith(op.response?.format ?? 'json', response.text, op, params) };
  } catch (error) {
    if (error instanceof SpecError) throw error;
    throw new SpecExtractError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Never talks to a host outside the configured allowlist — the same policy
 * `page_open`/`page_navigate` obey, so a spec cannot become a way around it.
 */
function assertAllowed(url: string, deps: SpecRunDeps): void {
  if (deps.domainPolicy === undefined) return;
  deps.domainPolicy.assertNavigableUrl(url);
}

/** Runs one op; failures come back as `{ok:false, error}` — never a throw. */
export async function runSpecOp(
  spec: SiteSpec,
  opName: string,
  params: Readonly<Record<string, string>>,
  deps: SpecRunDeps = {},
): Promise<OpResult> {
  const startedAt = Date.now();
  // Unknown op / unreadable spec are caller mistakes, not site problems: they
  // throw a SpecError so the MCP layer can answer with a typed code.
  const op = pickOp(spec, opName);
  const transport = op.transport ?? 'http';
  // Checked BEFORE the try: a host outside the allowlist must surface as the
  // typed domain error (like page_open/page_navigate), not as an extract hint.
  assertAllowed(fill(op.url ?? '', params), deps);
  try {
    const data = transport === 'browser-mcp' ? await runOpInBrowser(op, params, deps) : null;
    const http = transport === 'browser-mcp' ? null : await runOpOverHttp(op, params, deps);
    const resolved = transport === 'browser-mcp' ? data : http?.data;
    const status = transport === 'browser-mcp' ? 200 : (http?.status ?? null);
    if (resolved === null || resolved === undefined) {
      return {
        ok: false,
        status,
        ms: Date.now() - startedAt,
        data: null,
        error: 'no data at extract path (site changed?)',
      };
    }
    return { ok: true, status, ms: Date.now() - startedAt, data: resolved, error: null };
  } catch (error) {
    if (error instanceof SpecError || error instanceof BrowserAdapterError) throw error;
    const ms = Date.now() - startedAt;
    if (error instanceof SpecHttpError) {
      return { ok: false, status: error.status, ms, data: null, error: error.message };
    }
    if (error instanceof SpecExtractError) {
      return { ok: false, status: null, ms, data: null, error: `extract failed: ${error.message}` };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: null,
      ms,
      data: null,
      error: transport === 'browser-mcp' ? `browser-mcp failed: ${message}` : `extract failed: ${message}`,
    };
  }
}

export interface SpecCheckOutcome {
  readonly result: OpResult;
  readonly check: CheckResult;
  readonly ok: boolean;
}

/**
 * The `check` contract: run the op with the spec's holdout params and require
 * every expected field in EVERY row. This is what makes a site change fail
 * loudly instead of yielding plausible-looking empty data.
 */
export async function runSpecCheck(
  spec: SiteSpec,
  opName: string,
  params: Readonly<Record<string, string>>,
  deps: SpecRunDeps = {},
): Promise<SpecCheckOutcome> {
  const op = pickOp(spec, opName);
  const expect = op.check?.expect ?? [];
  const merged = { ...(op.check?.params ?? {}), ...params };
  const result = await runSpecOp(spec, opName, merged, deps);
  const check = checkMissing(result.data, expect);
  return { result, check, ok: result.ok && check.missing.length === 0 };
}

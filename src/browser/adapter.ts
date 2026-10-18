/**
 * BrowserAdapter — drives the user's existing, visible Chrome over CDP via
 * `playwright-core.connectOverCDP`.
 *
 * Security invariants (Stage 4):
 * - The endpoint is validated and address-pinned through the Stage 2 secure
 *   resolver BEFORE any connection; the CDP WebSocket hop connects to the
 *   pinned address, so DNS is never consulted twice.
 * - Extra headers (e.g. the gateway `Authorization` bearer) are supported; a
 *   caller-supplied `host` header is always ignored.
 * - `disconnect()` never terminates the user's Chrome: `browser.close()` on a
 *   CDP-attached browser only detaches (verified by integration tests).
 * - No API evaluates caller-provided JavaScript; extraction uses fixed
 *   Playwright accessors only.
 * - Password fields can never be filled, and their values are masked in
 *   snapshots, extraction results, and logs.
 * - Tab count and concurrent-operation count are bounded; every operation has
 *   a timeout and honours an `AbortSignal`.
 * - Stage 6: `visibleModeRequired` refuses headless browsers at connect time
 *   (the user must see the tab to take over); `challengeScan` gathers
 *   server-internal CAPTCHA-detection signals; `bringToFront` makes the
 *   challenged tab visible; `describeLocator` reads an element's accessible
 *   name for the sensitive-action confirmation check.
 */
import {
  chromium,
  errors as playwrightErrors,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright-core';
import type { Logger } from 'pino';
import {
  CdpEndpointError,
  fetchCdpWebSocketDebuggerUrl,
  probeCdpVersion,
  resolveSecureCdpEndpoint,
  type ResolvedCdpEndpoint,
} from '../cdp/endpoint.js';
import { logger as rootLogger } from '../logging/logger.js';
import { LocatorSpecError, resolveLocator, type LocatorSpec } from './locator.js';
import { REDACTED, isPasswordField, redactAriaSnapshot } from './redact.js';
import { OperationSemaphore, SemaphoreFullError, type SemaphoreRelease } from './semaphore.js';

export type BrowserAdapterErrorCode =
  | 'invalid_config'
  | 'invalid_argument'
  | 'endpoint_forbidden'
  | 'connect_failed'
  | 'not_connected'
  | 'browser_disconnected'
  | 'page_closed'
  | 'unknown_page'
  | 'tab_limit_exceeded'
  | 'too_many_operations'
  | 'timeout'
  | 'aborted'
  | 'sensitive_field_forbidden'
  | 'locator_invalid'
  | 'screenshot_too_large'
  | 'operation_failed'
  | 'closed';

export class BrowserAdapterError extends Error {
  readonly code: BrowserAdapterErrorCode;

  constructor(code: BrowserAdapterErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BrowserAdapterError';
    this.code = code;
  }
}

export const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_TABS = 8;
export const DEFAULT_MAX_CONCURRENT_OPERATIONS = 4;
export const DEFAULT_MAX_QUEUED_OPERATIONS = 16;
export const DEFAULT_MAX_EXTRACT_ITEMS = 100;
export const DEFAULT_MAX_EXTRACT_CHARS_PER_ITEM = 2_000;
export const DEFAULT_MAX_EXTRACT_CHARS = 20_000;
export const DEFAULT_MAX_SNAPSHOT_CHARS = 200_000;
export const DEFAULT_MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_CHALLENGE_TEXT_CHARS = 8_000;
export const MAX_ELEMENT_DESCRIPTION_CHARS = 200;
const MAX_FILL_CHARS = 10_000;

export interface BrowserAdapterOptions {
  /** CDP endpoint: http(s)://host:port or ws(s)://host:port/devtools/... */
  readonly endpoint: string;
  /** Extra headers for every probe/connect request, e.g. Authorization. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Administrator CIDR policy for the Stage 2 endpoint resolver. */
  readonly allowedCidrs?: readonly string[];
  readonly operationTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly maxTabs?: number;
  readonly maxConcurrentOperations?: number;
  readonly maxQueuedOperations?: number;
  readonly maxExtractItems?: number;
  readonly maxExtractCharsPerItem?: number;
  readonly maxExtractChars?: number;
  readonly maxSnapshotChars?: number;
  readonly maxScreenshotBytes?: number;
  /** Cap for the visible text gathered by `challengeScan` (Stage 6). */
  readonly maxChallengeTextChars?: number;
  /**
   * Refuse to connect when the CDP endpoint reports a headless browser
   * (`HeadlessChrome` in the `/json/version` User-Agent). The user must be
   * able to SEE the tab to take over (CAPTCHA, login). Defaults to true;
   * disable only for automated testing.
   */
  readonly visibleModeRequired?: boolean;
  /**
   * Passed to `connectOverCDP` as `noDefaults`: Playwright will not override
   * downloads/focus/media emulation of the user's default context. Right for
   * a daily-driver browser; defaults to true.
   */
  readonly noDefaults?: boolean;
  readonly logger?: Logger;
}

export interface OperationOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
export type WaitForLoadState = 'load' | 'domcontentloaded' | 'networkidle';
export type WaitForState = 'attached' | 'detached' | 'visible' | 'hidden';

export interface PageInfo {
  readonly pageId: string;
  readonly contextId: string;
  readonly url: string;
  readonly title: string;
}

export interface AdapterStatus {
  readonly connected: boolean;
  /** Origin of the configured endpoint; never contains credentials or paths. */
  readonly endpoint: string;
  readonly browserVersion?: string;
  readonly protocolVersion?: string;
  readonly tabs: number;
  readonly contexts: number;
  readonly runningOperations: number;
  readonly queuedOperations: number;
  readonly limits: {
    readonly maxTabs: number;
    readonly maxConcurrentOperations: number;
    readonly maxQueuedOperations: number;
    readonly operationTimeoutMs: number;
  };
}

export interface ExtractResult {
  readonly url: string;
  readonly title: string;
  /** Element texts (locator mode) or the body text (page mode). */
  readonly items: readonly string[];
  readonly truncated: boolean;
}

export interface OpenPageParams extends OperationOptions {
  readonly url?: string;
}

export interface NavigateParams extends OperationOptions {
  readonly pageId: string;
  readonly url: string;
  readonly waitUntil?: WaitUntil;
}

export interface LocatorParams extends OperationOptions {
  readonly pageId: string;
  readonly locator: LocatorSpec;
  readonly nth?: number;
}

export interface FillParams extends LocatorParams {
  readonly value: string;
}

export interface SelectOptionParams extends LocatorParams {
  readonly values?: readonly string[];
  readonly label?: string;
  readonly index?: number;
}

export interface PressParams extends OperationOptions {
  readonly pageId: string;
  readonly key: string;
  readonly locator?: LocatorSpec;
  readonly nth?: number;
}

export interface WaitParams extends OperationOptions {
  readonly pageId: string;
  readonly locator?: LocatorSpec;
  readonly nth?: number;
  readonly state?: WaitForState;
  readonly loadState?: WaitForLoadState;
}

export interface ExtractParams extends OperationOptions {
  readonly pageId: string;
  readonly locator?: LocatorSpec;
  readonly nth?: number;
}

export interface ScreenshotParams extends OperationOptions {
  readonly pageId: string;
  readonly fullPage?: boolean;
}

/**
 * Server-internal signals for probable-CAPTCHA detection (Stage 6).
 * `visibleText` and `frameUrls` must NEVER leave the server: they are inputs
 * to the challenge classifier only and can carry page content/frame tokens.
 */
export interface ChallengeScan {
  readonly url: string;
  readonly title: string;
  /** URLs of all frames (main frame included). */
  readonly frameUrls: readonly string[];
  /** Visible body text, whitespace-normalized and capped. */
  readonly visibleText: string;
}

/**
 * Safe description of a locator's target element for the sensitive-action
 * confirmation check: accessible name / visible text only — never values.
 */
export interface ElementDescription {
  readonly name: string;
}

export interface BrowserAdapter {
  connect(options?: OperationOptions): Promise<AdapterStatus>;
  /** Detaches from Chrome; the browser process and its tabs keep running. */
  disconnect(): Promise<void>;
  /** Disconnects and permanently disables the adapter. */
  dispose(): Promise<void>;
  isConnected(): boolean;
  status(): AdapterStatus;
  listPages(options?: OperationOptions): Promise<PageInfo[]>;
  openPage(params?: OpenPageParams): Promise<PageInfo>;
  navigate(params: NavigateParams): Promise<PageInfo>;
  /** Redacted ARIA snapshot of the page. */
  snapshot(params: { pageId: string } & OperationOptions): Promise<string>;
  screenshot(params: ScreenshotParams): Promise<Buffer>;
  click(params: LocatorParams): Promise<void>;
  /** Refuses password fields (`sensitive_field_forbidden`). */
  fill(params: FillParams): Promise<void>;
  selectOption(params: SelectOptionParams): Promise<readonly string[]>;
  press(params: PressParams): Promise<void>;
  wait(params: WaitParams): Promise<void>;
  /** Visible text only; password field values are returned as [REDACTED]. */
  extract(params: ExtractParams): Promise<ExtractResult>;
  /**
   * Stage 6 human control: gathers challenge-detection signals (URL, frame
   * URLs, visible text). The result is server-internal and must never be
   * returned to the model.
   */
  challengeScan(params: { pageId: string } & OperationOptions): Promise<ChallengeScan>;
  /** Stage 6 human control: activates the tab so the user can see it. */
  bringToFront(params: { pageId: string } & OperationOptions): Promise<void>;
  /**
   * Stage 6 human control: accessible name / visible text of a locator's
   * target, used to classify sensitive actions before clicking.
   */
  describeLocator(params: LocatorParams): Promise<ElementDescription>;
}

const WAIT_UNTIL_VALUES = new Set<string>(['load', 'domcontentloaded', 'networkidle', 'commit']);
const LOAD_STATE_VALUES = new Set<string>(['load', 'domcontentloaded', 'networkidle']);
const WAIT_STATE_VALUES = new Set<string>(['attached', 'detached', 'visible', 'hidden']);

function firstLine(message: string): string {
  const newline = message.indexOf('\n');
  return newline === -1 ? message : message.slice(0, newline);
}

/**
 * Strips paths from any URL inside an error message: a CDP debugger URL path
 * is a connection credential and must never surface in errors or logs.
 */
function stripUrlPaths(message: string): string {
  return message.replace(/\b(?:wss?|https?):\/\/[^\s"'`)\]]+/g, (raw) => {
    try {
      const parsed = new URL(raw);
      return `${parsed.protocol}//${parsed.host}/[REDACTED]`;
    } catch {
      return '[REDACTED]';
    }
  });
}

function briefCause(cause: unknown, maxChars = 300): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return stripUrlPaths(firstLine(message)).slice(0, maxChars);
}

function safeOrigin(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '[invalid-endpoint]';
  }
}

function truncateChars(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function truncateWithMarker(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[TRUNCATED]`;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function idNumber(id: string): number {
  const dash = id.lastIndexOf('-');
  const value = Number.parseInt(id.slice(dash + 1), 10);
  return Number.isFinite(value) ? value : 0;
}

function assertNavigableUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BrowserAdapterError('invalid_argument', 'url is not a valid URL');
  }
  if (url === 'about:blank') return;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BrowserAdapterError(
      'invalid_argument',
      `Navigation scheme "${parsed.protocol}" is not allowed; use http/https`,
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new BrowserAdapterError(
      'invalid_argument',
      'Navigation URL must not contain credentials',
    );
  }
}

function requirePositiveInt(name: string, value: number, min = 1): number {
  if (!Number.isInteger(value) || value < min) {
    throw new BrowserAdapterError('invalid_config', `${name} must be an integer >= ${min}`);
  }
  return value;
}

/**
 * Creates a BrowserAdapter. The adapter starts disconnected; call `connect()`.
 * Options are validated eagerly so a bad configuration fails before any
 * network activity.
 */
export function createBrowserAdapter(options: BrowserAdapterOptions): BrowserAdapter {
  if (!options || typeof options.endpoint !== 'string' || options.endpoint.trim() === '') {
    throw new BrowserAdapterError('invalid_config', 'endpoint is required');
  }
  try {
    new URL(options.endpoint);
  } catch {
    throw new BrowserAdapterError('invalid_config', 'endpoint is not a valid URL');
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (typeof value !== 'string' || value === '') {
      throw new BrowserAdapterError(
        'invalid_config',
        `header "${name}" must be a non-empty string`,
      );
    }
    // The validated host header can never be overridden by the caller.
    if (name.toLowerCase() === 'host') continue;
    headers[name] = value;
  }

  const config = {
    endpoint: options.endpoint,
    headers,
    allowedCidrs: options.allowedCidrs ?? [],
    operationTimeoutMs: requirePositiveInt(
      'operationTimeoutMs',
      options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
    ),
    connectTimeoutMs: requirePositiveInt(
      'connectTimeoutMs',
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    ),
    maxTabs: requirePositiveInt('maxTabs', options.maxTabs ?? DEFAULT_MAX_TABS),
    maxConcurrentOperations: requirePositiveInt(
      'maxConcurrentOperations',
      options.maxConcurrentOperations ?? DEFAULT_MAX_CONCURRENT_OPERATIONS,
    ),
    maxQueuedOperations: requirePositiveInt(
      'maxQueuedOperations',
      options.maxQueuedOperations ?? DEFAULT_MAX_QUEUED_OPERATIONS,
      0,
    ),
    maxExtractItems: requirePositiveInt(
      'maxExtractItems',
      options.maxExtractItems ?? DEFAULT_MAX_EXTRACT_ITEMS,
    ),
    maxExtractCharsPerItem: requirePositiveInt(
      'maxExtractCharsPerItem',
      options.maxExtractCharsPerItem ?? DEFAULT_MAX_EXTRACT_CHARS_PER_ITEM,
    ),
    maxExtractChars: requirePositiveInt(
      'maxExtractChars',
      options.maxExtractChars ?? DEFAULT_MAX_EXTRACT_CHARS,
    ),
    maxSnapshotChars: requirePositiveInt(
      'maxSnapshotChars',
      options.maxSnapshotChars ?? DEFAULT_MAX_SNAPSHOT_CHARS,
    ),
    maxScreenshotBytes: requirePositiveInt(
      'maxScreenshotBytes',
      options.maxScreenshotBytes ?? DEFAULT_MAX_SCREENSHOT_BYTES,
    ),
    maxChallengeTextChars: requirePositiveInt(
      'maxChallengeTextChars',
      options.maxChallengeTextChars ?? DEFAULT_MAX_CHALLENGE_TEXT_CHARS,
    ),
    visibleModeRequired: options.visibleModeRequired ?? true,
    noDefaults: options.noDefaults ?? true,
  };

  const logger = (options.logger ?? rootLogger).child({ component: 'browser-adapter' });
  const endpointOrigin = safeOrigin(config.endpoint);
  const semaphore = new OperationSemaphore(
    config.maxConcurrentOperations,
    config.maxQueuedOperations,
  );

  let browser: Browser | undefined;
  let disposed = false;
  let pendingOpens = 0;
  let protocolVersion: string | undefined;

  // Stable internal identifiers: counters only grow, ids are never reused, so
  // a pageId always refers to the same tab for the adapter's whole lifetime.
  let pageCounter = 0;
  let contextCounter = 0;
  const pagesById = new Map<string, Page>();
  const idsByPage = new Map<Page, string>();
  const contextsById = new Map<string, BrowserContext>();
  const idsByContext = new Map<BrowserContext, string>();

  function clearRegistry(): void {
    pagesById.clear();
    idsByPage.clear();
    contextsById.clear();
    idsByContext.clear();
  }

  function registerContext(context: BrowserContext): string {
    let id = idsByContext.get(context);
    if (id === undefined) {
      contextCounter += 1;
      id = `ctx-${contextCounter}`;
      idsByContext.set(context, id);
      contextsById.set(id, context);
      context.on('close', () => {
        idsByContext.delete(context);
        contextsById.delete(id as string);
      });
    }
    return id;
  }

  function registerPage(page: Page): string {
    let id = idsByPage.get(page);
    if (id === undefined) {
      pageCounter += 1;
      id = `page-${pageCounter}`;
      idsByPage.set(page, id);
      pagesById.set(id, page);
      page.on('close', () => {
        idsByPage.delete(page);
        pagesById.delete(id as string);
      });
    }
    return id;
  }

  /** Registers new tabs/contexts and prunes ones that disappeared. */
  function syncRegistry(): void {
    const current = browser;
    if (!current || !current.isConnected()) return;

    const liveContexts = new Set(current.contexts());
    for (const context of liveContexts) registerContext(context);
    for (const [context, id] of Array.from(idsByContext)) {
      if (!liveContexts.has(context)) {
        idsByContext.delete(context);
        contextsById.delete(id);
      }
    }

    const livePages = new Set<Page>();
    for (const context of liveContexts) {
      for (const page of context.pages()) {
        livePages.add(page);
        registerPage(page);
      }
    }
    for (const [page, id] of Array.from(idsByPage)) {
      if (!livePages.has(page) || page.isClosed()) {
        idsByPage.delete(page);
        pagesById.delete(id);
      }
    }
  }

  function requireBrowser(): Browser {
    const current = browser;
    if (!current || !current.isConnected()) {
      throw new BrowserAdapterError('browser_disconnected', 'Browser connection lost');
    }
    return current;
  }

  function getPage(pageId: string): Page {
    syncRegistry();
    const page = pagesById.get(pageId);
    if (!page) {
      throw new BrowserAdapterError('unknown_page', `Unknown pageId "${pageId}"`);
    }
    if (page.isClosed()) {
      idsByPage.delete(page);
      pagesById.delete(pageId);
      throw new BrowserAdapterError('page_closed', `Tab "${pageId}" is closed`);
    }
    return page;
  }

  async function pageInfo(page: Page): Promise<PageInfo> {
    const pageId = idsByPage.get(page);
    const contextId = idsByContext.get(page.context());
    if (!pageId || !contextId) {
      throw new BrowserAdapterError('unknown_page', 'Page is not registered with the adapter');
    }
    let title = '';
    try {
      title = await page.title();
    } catch {
      title = '';
    }
    return { pageId, contextId, url: page.url(), title };
  }

  function onBrowserDisconnected(): void {
    browser = undefined;
    protocolVersion = undefined;
    clearRegistry();
    logger.warn('browser connection lost (Chrome closed or restarted); reconnect via connect()');
  }

  function mapOperationError(
    op: string,
    error: unknown,
    signal: AbortSignal | undefined,
  ): BrowserAdapterError {
    if (error instanceof BrowserAdapterError) return error;
    if (signal?.aborted)
      return new BrowserAdapterError('aborted', `${op} aborted`, { cause: error });
    if (error instanceof LocatorSpecError) {
      return new BrowserAdapterError('locator_invalid', `${op}: ${error.message}`, {
        cause: error,
      });
    }
    if (error instanceof Error && error.name === 'AbortError') {
      return new BrowserAdapterError('aborted', `${op} aborted`, { cause: error });
    }
    const message = error instanceof Error ? error.message : String(error);
    if (
      error instanceof playwrightErrors.TimeoutError ||
      /^Timeout \d+ms exceeded/i.test(message)
    ) {
      return new BrowserAdapterError('timeout', `${op} timed out: ${briefCause(error)}`, {
        cause: error,
      });
    }
    const current = browser;
    if (!current || !current.isConnected()) {
      return new BrowserAdapterError(
        'browser_disconnected',
        `${op} failed: browser connection lost`,
        { cause: error },
      );
    }
    if (
      /Target closed|Target page, context or browser has been closed|Page, context or browser has been closed/i.test(
        message,
      )
    ) {
      return new BrowserAdapterError('page_closed', `${op} failed: the tab was closed`, {
        cause: error,
      });
    }
    if (/strict mode violation/i.test(message)) {
      return new BrowserAdapterError(
        'locator_invalid',
        `${op} failed: locator matched multiple elements; refine it or pass nth`,
        { cause: error },
      );
    }
    return new BrowserAdapterError('operation_failed', `${op} failed: ${briefCause(error)}`, {
      cause: error,
    });
  }

  async function withDeadline<T>(
    op: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    let onTimeout: (() => void) | undefined;
    let onCallerAbort: (() => void) | undefined;
    const deadline = new Promise<never>((_, reject) => {
      const fail = (): void => {
        reject(
          signal?.aborted
            ? new BrowserAdapterError('aborted', `${op} aborted`)
            : new BrowserAdapterError('timeout', `${op} timed out after ${timeoutMs} ms`),
        );
      };
      if (timeoutSignal.aborted || signal?.aborted) {
        fail();
        return;
      }
      onTimeout = fail;
      timeoutSignal.addEventListener('abort', onTimeout, { once: true });
      if (signal) {
        onCallerAbort = fail;
        signal.addEventListener('abort', onCallerAbort, { once: true });
      }
    });
    try {
      return await Promise.race([fn(), deadline]);
    } finally {
      if (onTimeout) timeoutSignal.removeEventListener('abort', onTimeout);
      if (onCallerAbort && signal) signal.removeEventListener('abort', onCallerAbort);
    }
  }

  async function run<T>(
    op: string,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
    fn: (timeoutMs: number) => Promise<T>,
  ): Promise<T> {
    if (disposed) throw new BrowserAdapterError('closed', 'Adapter is disposed');
    const current = browser;
    if (!current || !current.isConnected()) {
      throw new BrowserAdapterError(
        'not_connected',
        'Adapter is not connected; call connect() first',
      );
    }
    const effectiveTimeout = timeoutMs ?? config.operationTimeoutMs;
    if (!Number.isFinite(effectiveTimeout) || effectiveTimeout <= 0) {
      throw new BrowserAdapterError('invalid_argument', 'timeoutMs must be a positive number');
    }

    let release: SemaphoreRelease;
    try {
      release = await semaphore.acquire(signal);
    } catch (cause) {
      if (cause instanceof SemaphoreFullError) {
        throw new BrowserAdapterError('too_many_operations', cause.message, { cause });
      }
      throw mapOperationError(op, cause, signal);
    }
    try {
      return await withDeadline(op, effectiveTimeout, signal, () => fn(effectiveTimeout));
    } catch (error) {
      throw mapOperationError(op, error, signal);
    } finally {
      release();
    }
  }

  function withPage<T>(
    op: string,
    params: { pageId: string } & OperationOptions,
    fn: (page: Page, timeoutMs: number) => Promise<T>,
  ): Promise<T> {
    return run(op, params.timeoutMs, params.signal, (timeoutMs) =>
      fn(getPage(params.pageId), timeoutMs),
    );
  }

  function mapConnectStepError(
    step: string,
    cause: unknown,
    signal: AbortSignal | undefined,
    code: 'endpoint_forbidden' | 'connect_failed',
  ): BrowserAdapterError {
    if (signal?.aborted || (cause instanceof CdpEndpointError && cause.code === 'aborted')) {
      return new BrowserAdapterError('aborted', `connect aborted during ${step}`, { cause });
    }
    if (cause instanceof CdpEndpointError && cause.code === 'timeout') {
      return new BrowserAdapterError('timeout', `connect timed out during ${step}`, { cause });
    }
    return new BrowserAdapterError(code, `Failed to ${step}: ${briefCause(cause, 200)}`, { cause });
  }

  function pinnedHostForUrl(resolved: ResolvedCdpEndpoint): string {
    const host = resolved.pinnedAddresses[0] ?? resolved.host;
    return host.includes(':') ? `[${host}]` : host;
  }

  async function connect(options: OperationOptions = {}): Promise<AdapterStatus> {
    if (disposed) throw new BrowserAdapterError('closed', 'Adapter is disposed');
    if (browser && browser.isConnected()) return status();
    const signal = options.signal;

    let resolved: ResolvedCdpEndpoint;
    try {
      resolved = await resolveSecureCdpEndpoint(config.endpoint, {
        policy: { allowedCidrs: config.allowedCidrs },
        ...(signal ? { signal } : {}),
      });
    } catch (cause) {
      throw mapConnectStepError('validate CDP endpoint', cause, signal, 'endpoint_forbidden');
    }

    let probedProtocolVersion: string | undefined;
    try {
      const version = await probeCdpVersion(resolved, {
        headers: config.headers,
        timeoutMs: config.connectTimeoutMs,
        ...(signal ? { signal } : {}),
      });
      probedProtocolVersion = version.protocolVersion;
      // Stage 6 visible-mode enforcement: the user must be able to SEE the
      // tab to take over (CAPTCHA, login). Headless Chrome reports a UA
      // containing "HeadlessChrome" on /json/version. Only the presence of the
      // marker is ever surfaced — never the UA string itself.
      if (
        config.visibleModeRequired &&
        version.userAgent !== undefined &&
        /headlesschrome/i.test(version.userAgent)
      ) {
        throw new BrowserAdapterError(
          'endpoint_forbidden',
          'Visible-mode is required: the CDP endpoint reports a headless browser. ' +
            'Start Chrome with a visible window (human takeover must be possible), ' +
            'or set visibleModeRequired=false for automated tests only.',
        );
      }
    } catch (cause) {
      if (cause instanceof BrowserAdapterError) throw cause;
      throw mapConnectStepError('probe CDP endpoint', cause, signal, 'connect_failed');
    }

    let wsScheme: 'ws' | 'wss';
    let wsPath: string;
    if (resolved.scheme === 'ws' || resolved.scheme === 'wss') {
      wsScheme = resolved.scheme;
      const original = new URL(resolved.originalUrl);
      wsPath = `${original.pathname}${original.search}`;
    } else {
      // Fetch the debugger URL ourselves (pinned, authenticated) so the
      // WebSocket hop also connects to the validated address; Playwright must
      // never re-resolve the hostname on its own.
      let debuggerUrl: string | undefined;
      try {
        debuggerUrl = await fetchCdpWebSocketDebuggerUrl(resolved, {
          headers: config.headers,
          timeoutMs: config.connectTimeoutMs,
          ...(signal ? { signal } : {}),
        });
      } catch (cause) {
        throw mapConnectStepError('fetch CDP WebSocket endpoint', cause, signal, 'connect_failed');
      }
      if (!debuggerUrl) {
        throw new BrowserAdapterError(
          'connect_failed',
          'CDP endpoint did not provide a webSocketDebuggerUrl',
        );
      }
      let parsedDebugger: URL;
      try {
        parsedDebugger = new URL(debuggerUrl);
      } catch {
        throw new BrowserAdapterError(
          'connect_failed',
          'CDP endpoint returned an invalid webSocketDebuggerUrl',
        );
      }
      wsScheme = parsedDebugger.protocol === 'wss:' ? 'wss' : 'ws';
      wsPath = `${parsedDebugger.pathname}${parsedDebugger.search}`;
    }

    if (signal?.aborted) throw new BrowserAdapterError('aborted', 'connect aborted');

    const connectUrl = `${wsScheme}://${pinnedHostForUrl(resolved)}:${resolved.port}${wsPath}`;
    let connected: Browser;
    try {
      connected = await chromium.connectOverCDP(connectUrl, {
        headers: config.headers,
        timeout: config.connectTimeoutMs,
        noDefaults: config.noDefaults,
      });
    } catch (cause) {
      throw mapConnectStepError('connect over CDP', cause, signal, 'connect_failed');
    }

    browser = connected;
    connected.on('disconnected', onBrowserDisconnected);
    syncRegistry();
    protocolVersion = probedProtocolVersion;
    logger.info(
      { endpoint: endpointOrigin, protocolVersion, tabs: pagesById.size },
      'browser adapter connected (Chrome left running on disconnect)',
    );
    return status();
  }

  async function disconnect(): Promise<void> {
    const current = browser;
    browser = undefined;
    protocolVersion = undefined;
    clearRegistry();
    if (!current) return;
    current.removeListener('disconnected', onBrowserDisconnected);
    try {
      // On a CDP-attached browser, close() only detaches: the user's Chrome
      // process and all of its tabs keep running (proved by integration tests).
      await current.close();
    } catch {
      // The connection is already gone; nothing left to detach.
    }
    logger.info('browser adapter disconnected (Chrome left running)');
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    await disconnect();
  }

  function status(): AdapterStatus {
    const current = browser;
    const connected = current !== undefined && current.isConnected();
    if (connected) syncRegistry();
    const base: AdapterStatus = {
      connected,
      endpoint: endpointOrigin,
      tabs: pagesById.size,
      contexts: contextsById.size,
      runningOperations: semaphore.runningCount,
      queuedOperations: semaphore.waitingCount,
      limits: {
        maxTabs: config.maxTabs,
        maxConcurrentOperations: config.maxConcurrentOperations,
        maxQueuedOperations: config.maxQueuedOperations,
        operationTimeoutMs: config.operationTimeoutMs,
      },
    };
    if (!connected || !current) return base;
    return {
      ...base,
      browserVersion: current.version(),
      ...(protocolVersion ? { protocolVersion } : {}),
    };
  }

  async function listPages(options: OperationOptions = {}): Promise<PageInfo[]> {
    return run('listPages', options.timeoutMs, options.signal, async () => {
      syncRegistry();
      const infos: PageInfo[] = [];
      for (const page of Array.from(idsByPage.keys())) {
        infos.push(await pageInfo(page));
      }
      infos.sort((left, right) => idNumber(left.pageId) - idNumber(right.pageId));
      return infos;
    });
  }

  async function openPage(params: OpenPageParams = {}): Promise<PageInfo> {
    if (params.url !== undefined) assertNavigableUrl(params.url);
    return run('openPage', params.timeoutMs, params.signal, async (timeoutMs) => {
      syncRegistry();
      if (pagesById.size + pendingOpens >= config.maxTabs) {
        throw new BrowserAdapterError(
          'tab_limit_exceeded',
          `Tab limit reached: ${config.maxTabs} tabs are already open`,
        );
      }
      const current = requireBrowser();
      const context = current.contexts()[0];
      if (!context) {
        throw new BrowserAdapterError(
          'browser_disconnected',
          'No default browser context available',
        );
      }
      pendingOpens += 1;
      let page: Page;
      try {
        page = await context.newPage();
      } finally {
        pendingOpens -= 1;
      }
      registerPage(page);
      if (params.url !== undefined) {
        await page.goto(params.url, { timeout: timeoutMs, waitUntil: 'load' });
      }
      return pageInfo(page);
    });
  }

  async function navigate(params: NavigateParams): Promise<PageInfo> {
    assertNavigableUrl(params.url);
    const waitUntil = params.waitUntil ?? 'load';
    if (!WAIT_UNTIL_VALUES.has(waitUntil)) {
      throw new BrowserAdapterError('invalid_argument', `Unsupported waitUntil "${waitUntil}"`);
    }
    return withPage('navigate', params, async (page, timeoutMs) => {
      await page.goto(params.url, { timeout: timeoutMs, waitUntil });
      return pageInfo(page);
    });
  }

  async function snapshot(params: { pageId: string } & OperationOptions): Promise<string> {
    return withPage('snapshot', params, async (page, timeoutMs) => {
      const raw = await page.ariaSnapshot({ timeout: timeoutMs });
      return truncateWithMarker(redactAriaSnapshot(raw), config.maxSnapshotChars);
    });
  }

  async function screenshot(params: ScreenshotParams): Promise<Buffer> {
    return withPage('screenshot', params, async (page, timeoutMs) => {
      const buffer = await page.screenshot({
        type: 'png',
        fullPage: params.fullPage === true,
        timeout: timeoutMs,
      });
      if (buffer.byteLength > config.maxScreenshotBytes) {
        throw new BrowserAdapterError(
          'screenshot_too_large',
          `Screenshot exceeds ${config.maxScreenshotBytes} bytes`,
        );
      }
      return buffer;
    });
  }

  async function click(params: LocatorParams): Promise<void> {
    return withPage('click', params, async (page, timeoutMs) => {
      const target = resolveLocator(page, params.locator, params.nth);
      await target.click({ timeout: timeoutMs });
    });
  }

  async function fill(params: FillParams): Promise<void> {
    if (typeof params.value !== 'string') {
      throw new BrowserAdapterError('invalid_argument', 'value must be a string');
    }
    if (params.value.length > MAX_FILL_CHARS) {
      throw new BrowserAdapterError(
        'invalid_argument',
        `value exceeds ${MAX_FILL_CHARS} characters`,
      );
    }
    return withPage('fill', params, async (page, timeoutMs) => {
      const target = resolveLocator(page, params.locator, params.nth);
      const type = await target.getAttribute('type', { timeout: timeoutMs });
      const autocomplete = await target.getAttribute('autocomplete', { timeout: timeoutMs });
      if (isPasswordField(type, autocomplete)) {
        throw new BrowserAdapterError(
          'sensitive_field_forbidden',
          'fill is forbidden for password fields; the user types secrets manually',
        );
      }
      // The value is never logged and never echoed back in errors.
      await target.fill(params.value, { timeout: timeoutMs });
    });
  }

  async function selectOption(params: SelectOptionParams): Promise<readonly string[]> {
    return withPage('selectOption', params, async (page, timeoutMs) => {
      const target = resolveLocator(page, params.locator, params.nth);
      if (params.values !== undefined) {
        if (params.values.length === 0) {
          throw new BrowserAdapterError('invalid_argument', 'values must not be empty');
        }
        return target.selectOption(Array.from(params.values), { timeout: timeoutMs });
      }
      if (params.label !== undefined)
        return target.selectOption({ label: params.label }, { timeout: timeoutMs });
      if (params.index !== undefined)
        return target.selectOption({ index: params.index }, { timeout: timeoutMs });
      throw new BrowserAdapterError(
        'invalid_argument',
        'selectOption requires values, label or index',
      );
    });
  }

  async function press(params: PressParams): Promise<void> {
    if (typeof params.key !== 'string' || !/^\S{1,32}$/.test(params.key)) {
      throw new BrowserAdapterError(
        'invalid_argument',
        'key must be 1-32 characters without whitespace',
      );
    }
    return withPage('press', params, async (page, timeoutMs) => {
      if (params.locator !== undefined) {
        const target = resolveLocator(page, params.locator, params.nth);
        await target.press(params.key, { timeout: timeoutMs });
        return;
      }
      await page.keyboard.press(params.key);
    });
  }

  async function wait(params: WaitParams): Promise<void> {
    if (params.state !== undefined && !WAIT_STATE_VALUES.has(params.state)) {
      throw new BrowserAdapterError('invalid_argument', `Unsupported state "${params.state}"`);
    }
    if (params.loadState !== undefined && !LOAD_STATE_VALUES.has(params.loadState)) {
      throw new BrowserAdapterError(
        'invalid_argument',
        `Unsupported loadState "${params.loadState}"`,
      );
    }
    return withPage('wait', params, async (page, timeoutMs) => {
      if (params.locator !== undefined) {
        const target = resolveLocator(page, params.locator, params.nth);
        await target.waitFor({ state: params.state ?? 'visible', timeout: timeoutMs });
        return;
      }
      if (params.loadState !== undefined) {
        await page.waitForLoadState(params.loadState, { timeout: timeoutMs });
        return;
      }
      throw new BrowserAdapterError(
        'invalid_argument',
        'wait requires either locator or loadState',
      );
    });
  }

  async function extract(params: ExtractParams): Promise<ExtractResult> {
    return withPage('extract', params, async (page, timeoutMs) => {
      const url = page.url();
      let title = '';
      try {
        title = await page.title();
      } catch {
        title = '';
      }

      if (params.locator === undefined) {
        const body = page.locator('body');
        let text = '';
        try {
          text = await body.innerText({ timeout: timeoutMs });
        } catch {
          try {
            text = (await body.textContent({ timeout: timeoutMs })) ?? '';
          } catch {
            text = '';
          }
        }
        const normalized = normalizeWhitespace(text);
        return {
          url,
          title,
          items: [truncateChars(normalized, config.maxExtractChars)],
          truncated: normalized.length > config.maxExtractChars,
        };
      }

      const target = resolveLocator(page, params.locator, params.nth);
      const elements = await target.all();
      const limited = elements.slice(0, config.maxExtractItems);
      const items: string[] = [];
      for (const element of limited) {
        try {
          const type = await element.getAttribute('type', { timeout: timeoutMs });
          const autocomplete = await element.getAttribute('autocomplete', { timeout: timeoutMs });
          if (isPasswordField(type, autocomplete)) {
            items.push(REDACTED);
            continue;
          }
          let text: string;
          try {
            text = await element.innerText({ timeout: timeoutMs });
          } catch {
            text = (await element.textContent({ timeout: timeoutMs })) ?? '';
          }
          items.push(truncateChars(normalizeWhitespace(text), config.maxExtractCharsPerItem));
        } catch {
          // The element detached mid-extraction: skip it, keep the rest.
        }
      }
      return { url, title, items, truncated: elements.length > limited.length };
    });
  }

  async function challengeScan(
    params: { pageId: string } & OperationOptions,
  ): Promise<ChallengeScan> {
    return withPage('challengeScan', params, async (page, timeoutMs) => {
      const url = page.url();
      let title = '';
      try {
        title = await page.title();
      } catch {
        title = '';
      }
      // Frame URLs (main frame included) reveal embedded provider widgets
      // (reCAPTCHA/hCaptcha/Turnstile iframes). `frame.url()` is a Playwright
      // accessor — no JavaScript is evaluated.
      const frameUrls = page
        .frames()
        .map((frame) => frame.url())
        .filter((frameUrl) => frameUrl !== '' && frameUrl !== 'about:blank');

      const body = page.locator('body');
      let text = '';
      try {
        text = await body.innerText({ timeout: timeoutMs });
      } catch {
        try {
          text = (await body.textContent({ timeout: timeoutMs })) ?? '';
        } catch {
          text = '';
        }
      }
      // The gathered text is an input to the challenge classifier only; it is
      // capped and must never be returned to the model or logged.
      return {
        url,
        title,
        frameUrls,
        visibleText: truncateChars(normalizeWhitespace(text), config.maxChallengeTextChars),
      };
    });
  }

  async function bringToFront(params: { pageId: string } & OperationOptions): Promise<void> {
    return withPage('bringToFront', params, async (page) => {
      await page.bringToFront();
    });
  }

  async function describeLocator(params: LocatorParams): Promise<ElementDescription> {
    return withPage('describeLocator', params, async (page, timeoutMs) => {
      const target = resolveLocator(page, params.locator, params.nth);
      // Accessible name first (icon buttons), then visible text. Only fixed
      // Playwright accessors are used; input VALUES are never read.
      let name = '';
      try {
        name = (await target.getAttribute('aria-label', { timeout: timeoutMs })) ?? '';
      } catch {
        name = '';
      }
      if (normalizeWhitespace(name) === '') {
        try {
          name = await target.innerText({ timeout: timeoutMs });
        } catch {
          try {
            name = (await target.textContent({ timeout: timeoutMs })) ?? '';
          } catch {
            name = '';
          }
        }
      }
      return { name: truncateChars(normalizeWhitespace(name), MAX_ELEMENT_DESCRIPTION_CHARS) };
    });
  }

  return {
    connect,
    disconnect,
    dispose,
    isConnected: () => browser !== undefined && browser.isConnected(),
    status,
    listPages,
    openPage,
    navigate,
    snapshot,
    screenshot,
    click,
    fill,
    selectOption,
    press,
    wait,
    extract,
    challengeScan,
    bringToFront,
    describeLocator,
  };
}

/**
 * MCP tool registration (Stage 5 + Stage 6 human control).
 *
 * Exposes the Stage 4 BrowserAdapter as strictly typed MCP tools. Every input
 * is validated by the SDK from the Zod schemas BEFORE any handler runs; the
 * handlers then apply the policy layers (human-control state machine, domain
 * allowlist, sensitive-action confirmation) before anything reaches the
 * browser.
 *
 * Stage 6 flows:
 * - After page_open/page_navigate/page_click/page_press the page is scanned
 *   for a probable CAPTCHA (URL, iframe sources, visible text, known
 *   providers). On detection automation STOPS: the state machine moves to
 *   `human_required`, the challenged tab is brought to the front, and the
 *   tool returns pageId + hostname + a safe explanation. The challenge is
 *   never solved automatically.
 * - While the machine is in any waiting state, ALL page_* tools are refused —
 *   including reads — so the model can never observe what the user types.
 * - `human_resume` re-scans the challenged tab and only releases automation
 *   when the challenge is gone; otherwise the wait continues.
 * - Clicks that look like a purchase, a message, or an account change require
 *   a separate user confirmation via a single-use token.
 *
 * Errors are returned as structured results (`isError: true` plus
 * `structuredContent: { error: { code, message, retryable } }`), never as
 * raw exceptions. Cookies, headers, localStorage, credentials, filled values
 * and challenge-scan content can never appear in any result.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import {
  BrowserAdapterError,
  type AdapterStatus,
  type BrowserAdapter,
  type PageInfo,
} from '../browser/adapter.js';
import type { LocatorSpec } from '../browser/locator.js';
import { DomainPolicyError, type DomainPolicy } from '../policy/domains.js';
import {
  classifySensitiveAction,
  createConfirmationGate,
  sensitiveActionLabel,
  type ConfirmationGate,
} from '../policy/confirm.js';
import type { HumanGate } from '../human/gate.js';
import { challengeProviderLabel, describeChallenge, detectChallenge } from '../human/challenge.js';
import {
  browserConnectOutputShape,
  browserStatusOutputShape,
  humanRequiredInputSchema,
  humanRequiredOutputShape,
  humanResumeOutputShape,
  pageClickInputSchema,
  pageClickOutputShape,
  pageCloseInputSchema,
  pageCloseOutputShape,
  pageExtractInputSchema,
  pageExtractOutputShape,
  pageFillInputSchema,
  pageFillOutputShape,
  pageListOutputShape,
  pageNavigateInputSchema,
  pageNavigateOutputShape,
  pageOpenInputSchema,
  pageOpenOutputShape,
  pagePressInputSchema,
  pagePressOutputShape,
  pageScreenshotInputSchema,
  pageScreenshotOutputShape,
  pageSelectInputSchema,
  pageSelectOutputShape,
  pageSnapshotInputSchema,
  pageSnapshotOutputShape,
  pageWaitInputSchema,
  pageWaitOutputShape,
  toolOutputSchema,
  type LocatorInput,
} from './schemas.js';

/** Error codes for which retrying (after a corrective action) may succeed. */
const RETRYABLE_CODES = new Set<string>([
  'timeout',
  'aborted',
  'not_connected',
  'browser_disconnected',
  'connect_failed',
  'too_many_operations',
  'challenge_still_present',
  'confirmation_required',
]);

/**
 * Challenge scanning is best-effort and must never hang the triggering
 * operation: it runs with its own short deadline.
 */
const CHALLENGE_SCAN_TIMEOUT_MS = 5_000;
const DESCRIBE_TIMEOUT_MS = 5_000;

export interface BrowserToolDeps {
  readonly adapter: BrowserAdapter;
  readonly domainPolicy: DomainPolicy;
  readonly humanGate: HumanGate;
  readonly confirmationGate?: ConfirmationGate;
  readonly logger: Logger;
}

/** Strips URL paths: debugger-URL paths and query strings are credentials. */
function sanitizeMessage(message: string): string {
  return message
    .replace(/\b(?:wss?|https?):\/\/[^\s"'`)\]]+/g, (raw) => {
      try {
        const parsed = new URL(raw);
        return `${parsed.protocol}//${parsed.host}/[REDACTED]`;
      } catch {
        return '[REDACTED]';
      }
    })
    .slice(0, 500);
}

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

interface ToolFailure {
  readonly code: string;
  readonly message: string;
  readonly pageId?: string;
}

function classifyError(error: unknown): ToolFailure {
  if (error instanceof BrowserAdapterError) {
    return { code: error.code, message: sanitizeMessage(error.message) };
  }
  if (error instanceof DomainPolicyError) {
    return { code: error.code, message: sanitizeMessage(error.message) };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'internal_error', message: sanitizeMessage(message) || 'Unexpected error' };
}

function errorResult(failure: ToolFailure): CallToolResult {
  const retryable = RETRYABLE_CODES.has(failure.code);
  return {
    content: [{ type: 'text', text: `${failure.code}: ${failure.message}` }],
    isError: true,
    structuredContent: {
      error: {
        code: failure.code,
        message: failure.message,
        retryable,
        ...(failure.pageId !== undefined ? { pageId: failure.pageId } : {}),
      },
    },
  };
}

function okResult(text: string, structuredContent: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  };
}

function locatorToSpec(locator: LocatorInput): LocatorSpec {
  // The discriminated union maps 1:1 onto the adapter's LocatorSpec; the
  // adapter re-validates (lengths, engine prefixes) as defense in depth.
  return locator as LocatorSpec;
}

function pageInfoStructured(info: PageInfo): Record<string, unknown> {
  return {
    pageId: info.pageId,
    contextId: info.contextId,
    url: info.url,
    title: info.title,
    // Ownership must survive into page_list/page_open/page_navigate output:
    // page_close decisions and the model's planning depend on it.
    openedByAdapter: info.openedByAdapter === true,
  };
}

/**
 * Registers all browser tools on the MCP server. Tool names, schemas and
 * annotations are stable Stage 5 API; Stage 6 adds the human-control flows.
 */
export function registerBrowserTools(server: McpServer, deps: BrowserToolDeps): void {
  const { adapter, domainPolicy, humanGate } = deps;
  const confirmationGate = deps.confirmationGate ?? createConfirmationGate();
  const logger = deps.logger.child({ component: 'mcp-tools' });

  function statusStructured(status: AdapterStatus): Record<string, unknown> {
    const gate = humanGate.snapshot();
    return {
      ...status,
      humanControl: {
        state: gate.state,
        ...(gate.reason !== undefined ? { reason: gate.reason } : {}),
        ...(gate.pageId !== undefined ? { pageId: gate.pageId } : {}),
        ...(gate.kind !== undefined ? { kind: gate.kind } : {}),
        ...(gate.hostname !== undefined ? { hostname: gate.hostname } : {}),
        ...(gate.provider !== undefined ? { provider: gate.provider } : {}),
        ...(gate.pausedAt !== undefined ? { pausedAt: gate.pausedAt } : {}),
        ...(gate.timeoutAt !== undefined ? { timeoutAt: gate.timeoutAt } : {}),
      },
    };
  }

  function currentStatus(): Record<string, unknown> {
    return statusStructured(adapter.status());
  }

  /** Blocks page_* tools in every waiting state of the human-control machine. */
  function blockedWhilePaused(): CallToolResult | undefined {
    if (!humanGate.isPaused()) return undefined;
    const gate = humanGate.snapshot();
    if (gate.state === 'failed') {
      return errorResult({
        code: 'human_timeout',
        message: `The wait for the user timed out (${gate.reason ?? 'human action required'}). Automation stays blocked: call human_required to start a new wait, or human_resume if the user already finished.`,
        ...(gate.pageId !== undefined ? { pageId: gate.pageId } : {}),
      });
    }
    const reason = gate.reason ?? 'a human is required';
    return errorResult({
      code: 'human_required',
      message: `Automation is paused: ${reason}. The user must finish the action in the visible Chrome window; call human_resume afterwards.`,
      ...(gate.pageId !== undefined ? { pageId: gate.pageId } : {}),
    });
  }

  /** Tracks ready ↔ running around every page_* operation. */
  async function asOperation(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
    humanGate.operationStarted();
    try {
      return await fn();
    } finally {
      humanGate.operationFinished();
    }
  }

  /**
   * Stage 6 challenge guard: scans the tab after an operation that may have
   * triggered a CAPTCHA. On detection the state machine pauses, the tab is
   * brought to the front, and an error result with pageId + hostname + a safe
   * explanation is returned. Best-effort: a scan failure never breaks the
   * underlying operation. Scan content (text/frame URLs) never leaves here.
   */
  async function challengeGuard(pageId: string): Promise<CallToolResult | undefined> {
    if (humanGate.isPaused()) return undefined;
    if (!adapter.isConnected()) return undefined;
    let scan;
    try {
      scan = await adapter.challengeScan({ pageId, timeoutMs: CHALLENGE_SCAN_TIMEOUT_MS });
    } catch {
      return undefined;
    }
    const detection = detectChallenge(scan);
    if (!detection.detected) return undefined;

    const hostname = safeHostname(scan.url);
    const explanation = describeChallenge(detection, hostname);
    const gate = humanGate.challengeDetected({
      reason: explanation,
      pageId,
      kind: 'challenge',
      ...(hostname !== undefined ? { hostname } : {}),
      provider: challengeProviderLabel(detection.provider),
    });

    // The user must SEE the challenge: activate the tab (best-effort).
    try {
      await adapter.bringToFront({ pageId, timeoutMs: CHALLENGE_SCAN_TIMEOUT_MS });
    } catch {
      // The pause stands even if the tab cannot be activated.
    }

    logger.warn(
      { pageId, provider: detection.provider, signal: detection.signal, state: gate.state },
      'probable challenge detected; automation paused',
    );
    return errorResult({
      code: 'captcha_detected',
      message: `${explanation} Automation is stopped and the tab stays visible. NEVER attempt to solve it. The user must complete the check in the visible Chrome window; do not call page_* tools, call human_resume once the user is done.`,
      pageId,
    });
  }

  function fail(op: string, error: unknown): CallToolResult {
    const failure = classifyError(error);
    logger.warn({ tool: op, code: failure.code }, 'tool failed');
    return errorResult(failure);
  }

  // -------------------------------------------------------------------------
  // Connection and status
  // -------------------------------------------------------------------------

  server.registerTool(
    'browser_connect',
    {
      title: 'Connect to Chrome',
      description:
        'Attach to the configured visible Chrome over CDP (endpoint and credentials come from server config, never from arguments). Idempotent; call it before any page_* tool. Chrome keeps running after disconnect. Refuses headless browsers when visible mode is required.',
      outputSchema: toolOutputSchema(browserConnectOutputShape),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const status = await adapter.connect();
        return okResult(
          `Connected to Chrome at ${status.endpoint} (${status.tabs} tab(s)).`,
          statusStructured(status),
        );
      } catch (error) {
        return fail('browser_connect', error);
      }
    },
  );

  server.registerTool(
    'browser_status',
    {
      title: 'Browser status',
      description:
        'Connection state, tab/operation counters, limits and human-control state. Never returns cookies, headers, localStorage or credentials.',
      outputSchema: toolOutputSchema(browserStatusOutputShape),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => okResult('Browser status.', currentStatus()),
  );

  // -------------------------------------------------------------------------
  // Tabs
  // -------------------------------------------------------------------------

  server.registerTool(
    'page_list',
    {
      title: 'List tabs',
      description:
        'List all open tabs (including the user’s own) with stable internal pageId, URL and title. Blocked while human control is paused.',
      outputSchema: toolOutputSchema(pageListOutputShape),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const blocked = blockedWhilePaused();
      if (blocked) return blocked;
      return asOperation(async () => {
        try {
          const pages = await adapter.listPages();
          return okResult(`${pages.length} tab(s) open.`, { pages: pages.map(pageInfoStructured) });
        } catch (error) {
          return fail('page_list', error);
        }
      });
    },
  );

  server.registerTool(
    'page_open',
    {
      title: 'Open a new tab',
      description:
        'Open a new tab, optionally loading an allowed-domain URL (omit url for about:blank). Subject to the tab limit and the domain allowlist. The loaded page is checked for a probable CAPTCHA; on detection automation pauses.',
      inputSchema: pageOpenInputSchema,
      outputSchema: toolOutputSchema(pageOpenOutputShape),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const blocked = blockedWhilePaused();
      if (blocked) return blocked;
      if (args.url !== undefined) {
        try {
          domainPolicy.assertNavigableUrl(args.url);
        } catch (error) {
          return fail('page_open', error);
        }
      }
      return asOperation(async () => {
        let info: PageInfo;
        try {
          info = await adapter.openPage({
            ...(args.url !== undefined ? { url: args.url } : {}),
            ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          });
        } catch (error) {
          return fail('page_open', error);
        }
        const challenge = await challengeGuard(info.pageId);
        if (challenge) return challenge;
        return okResult(`Opened tab ${info.pageId} (${info.url}).`, pageInfoStructured(info));
      });
    },
  );

  server.registerTool(
    'page_navigate',
    {
      title: 'Navigate a tab',
      description:
        'Navigate an existing tab to an http/https URL. The hostname must be on the configured domain allowlist; URLs with credentials are rejected. The loaded page is checked for a probable CAPTCHA; on detection automation pauses.',
      inputSchema: pageNavigateInputSchema,
      outputSchema: toolOutputSchema(pageNavigateOutputShape),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const blocked = blockedWhilePaused();
      if (blocked) return blocked;
      try {
        domainPolicy.assertNavigableUrl(args.url);
      } catch (error) {
        return fail('page_navigate', error);
      }
      return asOperation(async () => {
        let info: PageInfo;
        try {
          info = await adapter.navigate({
            pageId: args.pageId,
            url: args.url,
            ...(args.waitUntil !== undefined ? { waitUntil: args.waitUntil } : {}),
            ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          });
        } catch (error) {
          return fail('page_navigate', error);
        }
        const challenge = await challengeGuard(info.pageId);
        if (challenge) return challenge;
        return okResult(`Navigated ${info.pageId} to ${info.url}.`, pageInfoStructured(info));
      });
    },
  );

  server.registerTool(
    'page_close',
    {
      title: 'Close a tab',
      description:
        'Close one tab by pageId and report how many tabs are left. A tab this automation opened itself (openedByAdapter true in page_list) is closed directly — use it to clean up after a scrape. Closing a tab the USER opened discards whatever it holds: that call returns confirmation_required with a single-use confirmToken, and may only be repeated with the token after the user explicitly agreed. Refuses to close the last open tab (last_tab_forbidden) because Chrome exits with its last tab. No beforeunload prompt is shown, so never close a tab with unsaved user work without asking. Blocked while human control is paused.',
      inputSchema: pageCloseInputSchema,
      outputSchema: toolOutputSchema(pageCloseOutputShape),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      const blocked = blockedWhilePaused();
      if (blocked) return blocked;
      return asOperation(async () => {
        // Ownership decides whether this is a plain cleanup or a destructive
        // action on the user's own tab; the adapter reports it per tab.
        let target: PageInfo | undefined;
        try {
          const pages = await adapter.listPages();
          target = pages.find((page) => page.pageId === args.pageId);
        } catch (error) {
          return fail('page_close', error);
        }
        if (!target) {
          return fail(
            'page_close',
            new BrowserAdapterError(
              'unknown_page',
              `Unknown pageId "${args.pageId}"; call page_list for the current tabs`,
            ),
          );
        }

        if (target.openedByAdapter !== true) {
          const confirmed =
            args.confirmToken !== undefined &&
            confirmationGate.consume(args.confirmToken, args.pageId, 'tab_close');
          if (!confirmed) {
            const hostname = safeHostname(target.url);
            const token = confirmationGate.request({
              pageId: args.pageId,
              kind: 'tab_close',
              description: hostname ?? '',
            });
            logger.info(
              { pageId: args.pageId, hostname },
              'closing a user tab requires explicit confirmation',
            );
            const message = `Tab ${args.pageId}${hostname !== undefined ? ` (${hostname})` : ''} was not opened by this automation — it is the user's own tab and closing it discards its state. Ask the user for EXPLICIT approval; only if the user agrees, repeat the identical call with confirmToken. Never close a user tab on your own initiative.`;
            return {
              content: [{ type: 'text', text: `confirmation_required: ${message}` }],
              isError: true,
              structuredContent: {
                error: {
                  code: 'confirmation_required',
                  message,
                  retryable: true,
                  pageId: args.pageId,
                },
                confirmToken: token,
                sensitiveAction: 'tab_close',
                pageId: args.pageId,
                url: target.url,
                ...(hostname !== undefined ? { hostname } : {}),
              },
            };
          }
          logger.info({ pageId: args.pageId }, 'closing a user tab confirmed');
        }

        let result;
        try {
          result = await adapter.closePage({
            pageId: args.pageId,
            ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          });
        } catch (error) {
          return fail('page_close', error);
        }
        return okResult(
          `Closed tab ${result.pageId} (${result.remainingTabs} tab(s) still open).`,
          {
            pageId: result.pageId,
            closed: true,
            remainingTabs: result.remainingTabs,
            url: result.url,
          },
        );
      });
    },
  );

  // -------------------------------------------------------------------------
  // Reading pages
  // -------------------------------------------------------------------------

  server.registerTool(
    'page_snapshot',
    {
      title: 'ARIA snapshot',
      description:
        'Redacted ARIA (YAML) snapshot of the tab for planning clicks/fills. Values of sensitive and unnamed fields are [REDACTED]. Blocked while human control is paused.',
      inputSchema: pageSnapshotInputSchema,
      outputSchema: toolOutputSchema(pageSnapshotOutputShape),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const blocked = blockedWhilePaused();
      if (blocked) return blocked;
      return asOperation(async () => {
        try {
          const snapshot = await adapter.snapshot({
            pageId: args.pageId,
            ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          });
          const truncated = snapshot.endsWith('[TRUNCATED]');
          return okResult(snapshot, { pageId: args.pageId, snapshot, truncated });
        } catch (error) {
          return fail('page_snapshot', error);
        }
      });
    },
  );

  server.registerTool(
    'page_screenshot',
    {
      title: 'Screenshot',
      description:
        'PNG screenshot of the tab (viewport by default, full page on request). The image is returned as an image content block; structured output carries metadata only.',
      inputSchema: pageScreenshotInputSchema,
      outputSchema: toolOutputSchema(pageScreenshotOutputShape),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const blocked = blockedWhilePaused();
      if (blocked) return blocked;
      return asOperation(async () => {
        try {
          const fullPage = args.fullPage === true;
          const buffer = await adapter.screenshot({
            pageId: args.pageId,
            fullPage,
            ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          });
          return {
            content: [
              {
                type: 'image',
                data: buffer.toString('base64'),
                mimeType: 'image/png',
              },
            ],
            structuredContent: {
              pageId: args.pageId,
              mimeType: 'image/png',
              sizeBytes: buffer.byteLength,
              fullPage,
            },
          };
        } catch (error) {
          return fail('page_screenshot', error);
        }
      });
    },
  );

  server.registerTool(
    'page_extract',
    {
      title: 'Extract visible text',
      description:
        'Extract visible text: all elements matching a locator, or the whole body text when no locator is given. Password field values come back as [REDACTED]; no JavaScript is evaluated.',
      inputSchema: pageExtractInputSchema,
      outputSchema: toolOutputSchema(pageExtractOutputShape),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const blocked = blockedWhilePaused();
      if (blocked) return blocked;
      return asOperation(async () => {
        try {
          const result = await adapter.extract({
            pageId: args.pageId,
            ...(args.locator !== undefined ? { locator: locatorToSpec(args.locator) } : {}),
            ...(args.nth !== undefined ? { nth: args.nth } : {}),
            ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          });
          return okResult(result.items.join('\n'), {
            pageId: args.pageId,
            url: result.url,
            title: result.title,
            items: result.items,
            truncated: result.truncated,
          });
        } catch (error) {
          return fail('page_extract', error);
        }
      });
    },
  );

  // -------------------------------------------------------------------------
  // Acting on pages
  // -------------------------------------------------------------------------

  server.registerTool(
    'page_click',
    {
      title: 'Click',
      description:
        'Click an element found by a role/label/text/CSS locator. Use page_snapshot first to pick the locator; pass nth when several elements match. Clicks that look like a PURCHASE, SENDING A MESSAGE or an ACCOUNT CHANGE are refused until the user explicitly approves: repeat the call with the confirmToken from the confirmation_required error. The clicked page is checked for a probable CAPTCHA afterwards.',
      inputSchema: pageClickInputSchema,
      outputSchema: toolOutputSchema(pageClickOutputShape),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const blocked = blockedWhilePaused();
      if (blocked) return blocked;
      return asOperation(async () => {
        const locator = locatorToSpec(args.locator);
        const locatorParams = {
          pageId: args.pageId,
          locator,
          ...(args.nth !== undefined ? { nth: args.nth } : {}),
        };

        // Stage 6: separate confirmation for purchases/messages/account changes.
        // The target is described via fixed accessors only (accessible name /
        // visible text — never input values).
        let description = '';
        try {
          const described = await adapter.describeLocator({
            ...locatorParams,
            timeoutMs: DESCRIBE_TIMEOUT_MS,
          });
          description = described.name;
        } catch (error) {
          // With a token we must be able to classify the target; otherwise the
          // click itself will surface the real error below.
          if (args.confirmToken !== undefined) return fail('page_click', error);
        }
        const sensitiveKind = classifySensitiveAction(description);
        if (sensitiveKind !== undefined) {
          const confirmed =
            args.confirmToken !== undefined &&
            confirmationGate.consume(args.confirmToken, args.pageId, sensitiveKind);
          if (!confirmed) {
            const token = confirmationGate.request({
              pageId: args.pageId,
              kind: sensitiveKind,
              description,
            });
            logger.info(
              { pageId: args.pageId, kind: sensitiveKind },
              'sensitive click requires explicit user confirmation',
            );
            const message = `This click looks like ${sensitiveActionLabel(sensitiveKind)}${description ? ` ("${description}")` : ''}. Ask the user for EXPLICIT approval; only if the user agrees, repeat the identical call with confirmToken. Never confirm on the user's behalf.`;
            return {
              content: [{ type: 'text', text: `confirmation_required: ${message}` }],
              isError: true,
              structuredContent: {
                error: {
                  code: 'confirmation_required',
                  message,
                  retryable: true,
                  pageId: args.pageId,
                },
                confirmToken: token,
                sensitiveAction: sensitiveKind,
                ...(description !== '' ? { description } : {}),
              },
            };
          }
          logger.info({ pageId: args.pageId, kind: sensitiveKind }, 'sensitive click confirmed');
        }

        try {
          await adapter.click({
            ...locatorParams,
            ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          });
        } catch (error) {
          return fail('page_click', error);
        }
        const challenge = await challengeGuard(args.pageId);
        if (challenge) return challenge;
        return okResult(`Clicked on ${args.pageId}.`, { pageId: args.pageId, clicked: true });
      });
    },
  );

  server.registerTool(
    'page_fill',
    {
      title: 'Fill a field',
      description:
        'Type a value into a text field found by a locator. REFUSED for password fields (type=password or password autocomplete) — the user types secrets manually. The value is never returned or logged.',
      inputSchema: pageFillInputSchema,
      outputSchema: toolOutputSchema(pageFillOutputShape),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const blocked = blockedWhilePaused();
      if (blocked) return blocked;
      return asOperation(async () => {
        try {
          await adapter.fill({
            pageId: args.pageId,
            locator: locatorToSpec(args.locator),
            value: args.value,
            ...(args.nth !== undefined ? { nth: args.nth } : {}),
            ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          });
          // The filled value is deliberately never echoed back.
          return okResult(`Filled field on ${args.pageId} (value not returned).`, {
            pageId: args.pageId,
            filled: true,
          });
        } catch (error) {
          return fail('page_fill', error);
        }
      });
    },
  );

  server.registerTool(
    'page_select',
    {
      title: 'Select an option',
      description:
        'Select option(s) in a <select> element by option values, by visible label or by index. Returns the values now selected.',
      inputSchema: pageSelectInputSchema,
      outputSchema: toolOutputSchema(pageSelectOutputShape),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const blocked = blockedWhilePaused();
      if (blocked) return blocked;
      return asOperation(async () => {
        try {
          const selected = await adapter.selectOption({
            pageId: args.pageId,
            locator: locatorToSpec(args.locator),
            ...(args.values !== undefined ? { values: args.values } : {}),
            ...(args.label !== undefined ? { label: args.label } : {}),
            ...(args.index !== undefined ? { index: args.index } : {}),
            ...(args.nth !== undefined ? { nth: args.nth } : {}),
            ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          });
          return okResult(`Selected ${selected.length} option(s) on ${args.pageId}.`, {
            pageId: args.pageId,
            selectedValues: Array.from(selected),
          });
        } catch (error) {
          return fail('page_select', error);
        }
      });
    },
  );

  server.registerTool(
    'page_press',
    {
      title: 'Press a key',
      description:
        'Press a key (e.g. "Enter", "Tab", "Control+A") on the page, or on a specific element when a locator is given. The page is checked for a probable CAPTCHA afterwards.',
      inputSchema: pagePressInputSchema,
      outputSchema: toolOutputSchema(pagePressOutputShape),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const blocked = blockedWhilePaused();
      if (blocked) return blocked;
      return asOperation(async () => {
        try {
          await adapter.press({
            pageId: args.pageId,
            key: args.key,
            ...(args.locator !== undefined ? { locator: locatorToSpec(args.locator) } : {}),
            ...(args.nth !== undefined ? { nth: args.nth } : {}),
            ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          });
        } catch (error) {
          return fail('page_press', error);
        }
        const challenge = await challengeGuard(args.pageId);
        if (challenge) return challenge;
        return okResult(`Pressed ${args.key} on ${args.pageId}.`, {
          pageId: args.pageId,
          pressed: true,
        });
      });
    },
  );

  server.registerTool(
    'page_wait',
    {
      title: 'Wait',
      description:
        'Wait for a locator to reach a state (default visible) or for a page load state. Requires either locator or loadState.',
      inputSchema: pageWaitInputSchema,
      outputSchema: toolOutputSchema(pageWaitOutputShape),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const blocked = blockedWhilePaused();
      if (blocked) return blocked;
      return asOperation(async () => {
        try {
          await adapter.wait({
            pageId: args.pageId,
            ...(args.locator !== undefined ? { locator: locatorToSpec(args.locator) } : {}),
            ...(args.state !== undefined ? { state: args.state } : {}),
            ...(args.loadState !== undefined ? { loadState: args.loadState } : {}),
            ...(args.nth !== undefined ? { nth: args.nth } : {}),
            ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          });
          return okResult(`Wait condition met on ${args.pageId}.`, {
            pageId: args.pageId,
            waited: true,
          });
        } catch (error) {
          return fail('page_wait', error);
        }
      });
    },
  );

  // -------------------------------------------------------------------------
  // Human control (Stage 6 state machine)
  // -------------------------------------------------------------------------

  server.registerTool(
    'human_required',
    {
      title: 'Hand over to the human',
      description:
        'Pause automation because the user must act in the visible Chrome (CAPTCHA, login, sensitive confirmation). Never attempt to solve a CAPTCHA; the user performs logins manually (sessions continue afterwards without reading passwords/cookies). While paused, ALL page_* tools are refused — including reads — until human_resume. The given tab is brought to the front.',
      inputSchema: humanRequiredInputSchema,
      outputSchema: toolOutputSchema(humanRequiredOutputShape),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      // Best-effort hostname so the user knows where to look; never fails the
      // pause itself.
      let hostname: string | undefined;
      if (args.pageId !== undefined && adapter.isConnected()) {
        try {
          const pages = await adapter.listPages();
          const target = pages.find((page) => page.pageId === args.pageId);
          if (target) hostname = safeHostname(target.url);
        } catch {
          hostname = undefined;
        }
      }

      const gate = humanGate.pause({
        reason: args.reason,
        ...(args.pageId !== undefined ? { pageId: args.pageId } : {}),
        kind: 'manual',
        ...(hostname !== undefined ? { hostname } : {}),
      });

      // The user must SEE the tab they take over (best-effort).
      if (args.pageId !== undefined && adapter.isConnected()) {
        try {
          await adapter.bringToFront({ pageId: args.pageId, timeoutMs: CHALLENGE_SCAN_TIMEOUT_MS });
        } catch {
          // The pause stands even if the tab cannot be activated.
        }
      }

      const message =
        'Automation is paused. The user must complete the action in the visible Chrome window. Do not call page_* tools; call human_resume once the user confirms.';
      logger.info({ pageId: args.pageId, state: gate.state }, 'human control: automation paused');
      return okResult(message, {
        paused: true,
        state: gate.state,
        reason: gate.reason ?? args.reason,
        ...(gate.pageId !== undefined ? { pageId: gate.pageId } : {}),
        ...(gate.hostname !== undefined
          ? { hostname: gate.hostname }
          : hostname !== undefined
            ? { hostname }
            : {}),
        ...(gate.kind !== undefined ? { kind: gate.kind } : {}),
        ...(gate.timeoutAt !== undefined ? { timeoutAt: gate.timeoutAt } : {}),
        message,
      });
    },
  );

  server.registerTool(
    'human_resume',
    {
      title: 'Resume automation',
      description:
        'Resume automation after the user finished the manual action in the visible Chrome. When automation paused on a detected challenge, the tab is re-scanned first: if the challenge is still present the wait continues. Idempotent. Continues on the SAME tab (pageIds stay valid).',
      outputSchema: toolOutputSchema(humanResumeOutputShape),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      if (!humanGate.isPaused()) {
        // Idempotent: nothing to resume.
        return okResult('Automation is active.', {
          resumed: true,
          state: 'ready',
          status: currentStatus(),
        });
      }
      const before = humanGate.snapshot();
      humanGate.beginResume();

      // A detected challenge must be VERIFIED gone before automation is
      // released; the scan content never leaves the server.
      if (before.kind === 'challenge' && before.pageId !== undefined && adapter.isConnected()) {
        try {
          const scan = await adapter.challengeScan({
            pageId: before.pageId,
            timeoutMs: CHALLENGE_SCAN_TIMEOUT_MS,
          });
          const detection = detectChallenge(scan);
          if (detection.detected) {
            humanGate.abortResume();
            const hostname = safeHostname(scan.url);
            logger.info(
              { pageId: before.pageId, provider: detection.provider },
              'resume rejected: challenge still present',
            );
            return errorResult({
              code: 'challenge_still_present',
              message: `${describeChallenge(detection, hostname)} The user is not done yet; automation stays paused. Call human_resume again once the user finished the check.`,
              pageId: before.pageId,
            });
          }
        } catch {
          // The tab was closed or cannot be scanned: the challenge is no
          // longer on screen, so the resume proceeds.
        }
      }

      humanGate.completeResume();
      logger.info('human control: automation resumed');
      return okResult('Automation resumed.', {
        resumed: true,
        state: 'ready',
        status: currentStatus(),
      });
    },
  );
}

/**
 * The advertised output schema of every tool: success fields (optional) plus
 * the optional `error` branch — see `toolOutputSchema` in schemas.ts.
 * Re-exported for tests and documentation.
 */
export const browserToolOutputSchemas = {
  browser_connect: toolOutputSchema(browserConnectOutputShape),
  browser_status: toolOutputSchema(browserStatusOutputShape),
  page_list: toolOutputSchema(pageListOutputShape),
  page_open: toolOutputSchema(pageOpenOutputShape),
  page_navigate: toolOutputSchema(pageNavigateOutputShape),
  page_close: toolOutputSchema(pageCloseOutputShape),
  page_snapshot: toolOutputSchema(pageSnapshotOutputShape),
  page_screenshot: toolOutputSchema(pageScreenshotOutputShape),
  page_click: toolOutputSchema(pageClickOutputShape),
  page_fill: toolOutputSchema(pageFillOutputShape),
  page_select: toolOutputSchema(pageSelectOutputShape),
  page_press: toolOutputSchema(pagePressOutputShape),
  page_wait: toolOutputSchema(pageWaitOutputShape),
  page_extract: toolOutputSchema(pageExtractOutputShape),
  human_required: toolOutputSchema(humanRequiredOutputShape),
  human_resume: toolOutputSchema(humanResumeOutputShape),
} as const;

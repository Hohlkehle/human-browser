/**
 * Browser MCP server factory (Stage 5, Stage 6 human control).
 *
 * Assembles the McpServer: implementation info, security instructions for the
 * model, and the browser tools wired to the Stage 4 adapter, the domain
 * allowlist policy, the human-control state machine and the sensitive-action
 * confirmation gate. Transports (STDIO or Streamable HTTP) are attached by the
 * caller.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { logger as rootLogger } from '../logging/logger.js';
import type { BrowserAdapter } from '../browser/adapter.js';
import type { DomainPolicy } from '../policy/domains.js';
import type { ConfirmationGate } from '../policy/confirm.js';
import { createConfirmationGate } from '../policy/confirm.js';
import type { HumanGate } from '../human/gate.js';
import { registerBrowserTools } from './tools.js';

export const SERVER_NAME = 'browser-mcp';

/**
 * Server instructions sent to every MCP client at initialization. They state
 * the security contract the model must follow when driving this server.
 */
export const SERVER_INSTRUCTIONS = `This server controls the user's REAL, VISIBLE Chrome browser over CDP.

Security rules (non-negotiable):
1. Live browser: every page_click / page_fill / page_press / page_select can have real-world effects (orders, payments, messages). Confirm the target with page_snapshot before acting.
2. Domain allowlist: page_navigate and page_open only accept hostnames from the configured allowlist. domain_forbidden errors cannot be bypassed; do not try other hosts, redirects, or URL tricks.
3. Secrets: page_fill ALWAYS refuses password fields (type=password or password autocomplete). Never attempt to type passwords, payment cards, OTP codes, or recovery phrases — the user types those manually. Filled values are never returned.
4. CAPTCHA and login: NEVER try to solve a CAPTCHA or automate a login. The server detects probable CAPTCHAs itself (captcha_detected) and pauses; you may also call human_required. The user completes the action in the visible Chrome window (logins included — sessions continue afterwards without anyone reading passwords or cookies), then call human_resume. human_resume is verified: if the challenge is still on screen it fails with challenge_still_present.
5. Human pause: while automation is paused (states human_required / waiting_for_user / resuming / failed), ALL page_* tools are refused — including read-only ones — so the user can type secrets unseen. Do not retry them; wait for human_resume. If the wait times out (human_timeout), ask the user whether to continue; then call human_required again or human_resume.
6. Sensitive actions: clicks that look like a purchase, sending a message, or an account change return confirmation_required with a single-use confirmToken. Present the action to the user; ONLY if the user explicitly agrees, repeat the identical call with that token. Never confirm on the user's behalf.
7. Privacy: results never contain cookies, HTTP headers, localStorage, or credentials. Snapshots and extracted text are redacted ([REDACTED]).
8. Tabs: pageId values ("page-N") are stable internal ids from page_list / page_open — never URLs or CDP ids. After a human pause, automation continues on the SAME tab. After a reconnect they are re-issued; call page_list again.
9. Errors are structured: { error: { code, message, retryable } }. Retry only when retryable is true and the cause has been addressed (e.g. call browser_connect after not_connected).`;

export interface BrowserMcpServerOptions {
  readonly adapter: BrowserAdapter;
  readonly domainPolicy: DomainPolicy;
  readonly humanGate: HumanGate;
  /**
   * Single-use confirmation tokens for sensitive clicks. Created once per
   * factory (shared by every built server instance) when not supplied.
   */
  readonly confirmationGate?: ConfirmationGate;
  /** Server version reported to clients; keep in sync with package.json. */
  readonly version?: string;
  readonly logger?: Logger;
}

export interface BrowserMcpServerHandle {
  /**
   * Builds a FRESH McpServer with all 15 tools registered. The SDK requires a
   * dedicated server+transport pair per STDIO connection and per Streamable
   * HTTP request (stateless transports are single-use); all real state lives
   * in the shared adapter/gate/policy, so instances are cheap. The caller
   * owns (and must close) every instance it builds.
   */
  build(): McpServer;
  readonly adapter: BrowserAdapter;
  readonly humanGate: HumanGate;
  readonly confirmationGate: ConfirmationGate;
}

export function createBrowserMcpServer(options: BrowserMcpServerOptions): BrowserMcpServerHandle {
  const logger = (options.logger ?? rootLogger).child({ component: 'mcp-server' });
  const confirmationGate = options.confirmationGate ?? createConfirmationGate();

  function build(): McpServer {
    const mcpServer = new McpServer(
      { name: SERVER_NAME, version: options.version ?? '0.0.0' },
      { instructions: SERVER_INSTRUCTIONS },
    );
    registerBrowserTools(mcpServer, {
      adapter: options.adapter,
      domainPolicy: options.domainPolicy,
      humanGate: options.humanGate,
      confirmationGate,
      logger,
    });
    return mcpServer;
  }

  logger.info('browser MCP server factory created (15 tools per instance)');

  return {
    build,
    adapter: options.adapter,
    humanGate: options.humanGate,
    confirmationGate,
  };
}

/**
 * Stage 9: end-to-end Partslink24 scenario — CI mock variant.
 *
 * The FULL scenario runs against a local Partslink24-like fixture (never the
 * real site) with the real stack: disposable Chrome -> BrowserAdapter ->
 * human-control gate -> MCP server over Streamable HTTP -> SDK client -> the
 * scenario engine. The "human" is simulated the same way the Stage 6 tests do
 * it: direct adapter navigation standing in for the user's hands — the
 * automation itself never submits credentials and never solves the CAPTCHA.
 *
 * Fixture state is cookie-based, so the test also proves the readiness
 * criterion "the full scenario without re-login": after the manual login the
 * same session cookie carries through search -> CAPTCHA -> results on the
 * SAME tab.
 */
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import pino, { type Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowserAdapter, type BrowserAdapter } from '../../src/browser/adapter.js';
import { createHumanGate, type HumanGate } from '../../src/human/gate.js';
import { createMcpHttpServer, type McpHttpServerHandle } from '../../src/mcp/http.js';
import { createBrowserMcpServer, type BrowserMcpServerHandle } from '../../src/mcp/server.js';
import { createDomainPolicy } from '../../src/policy/domains.js';
import {
  runPartslink24Scenario,
  type Partslink24Script,
  type ScenarioHandoff,
  type ScenarioReport,
  type ScenarioToolResult,
} from '../../src/scenarios/partslink24.js';
import { findChromeExecutable, startTestChrome, type TestChrome } from '../helpers/test-chrome.js';

const TEST_VIN = 'WVWZZZ1KZAW123456';
const TEST_VIN_MASKED = 'WVW********123456';

const LOGIN_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sign in - Partslink24 mock</title></head>
<body>
<h1>Sign in to Partslink24</h1>
<form method="post" action="/login">
  <label for="user">Username</label><input id="user" name="username">
  <label for="pass">Password</label><input id="pass" name="password" type="password">
  <button type="submit">Sign in</button>
</form>
</body>
</html>`;

const CATALOG_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Vehicle search - Partslink24 mock</title></head>
<body>
<h1>Vehicle search</h1>
<form method="get" action="/search">
  <label for="vin">VIN</label><input id="vin" name="vin">
  <button type="submit">Search</button>
</form>
</body>
</html>`;

const CHALLENGE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Security check</title></head>
<body>
<h1>Please verify you are human</h1>
<p>We need to confirm that you are not a robot before continuing.</p>
<iframe src="/recaptcha-frame" title="reCAPTCHA"></iframe>
</body>
</html>`;

const RESULTS_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Search results - Partslink24 mock</title></head>
<body>
<h1>Search results</h1>
<p id="vehicle">Vehicle: VW Golf VI 1.4 TSI</p>
<table id="parts">
  <thead><tr><th>Part number</th><th>Brand</th><th>Applicability</th></tr></thead>
  <tbody>
    <tr class="part"><td class="pn">06K103271B</td><td>VAG</td><td class="appl">Golf VI 1.4 TSI (2008-2013)</td></tr>
    <tr class="part"><td class="pn">06K103271C</td><td>VAG</td><td class="appl">Polo V 1.2 TSI (2009-2017)</td></tr>
  </tbody>
</table>
</body>
</html>`;

interface Fixture {
  readonly url: string;
  readonly counters: { loginPosts: number };
  close(): Promise<void>;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

async function startFixture(): Promise<Fixture> {
  const counters = { loginPosts: 0 };
  return await new Promise((resolve, reject) => {
    const server: Server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', 'http://fixture.invalid');
      const pathname = requestUrl.pathname;
      const cookies = parseCookies(request.headers.cookie);
      const hasSession = cookies['pl24session'] === 'ok';
      const captchaPassed = cookies['pl24captcha'] === 'ok';

      const html = (body: string): void => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(body);
      };
      const redirect = (to: string, setCookie?: string): void => {
        response.writeHead(302, {
          location: to,
          ...(setCookie !== undefined ? { 'set-cookie': `${setCookie}; Path=/` } : {}),
        });
        response.end();
      };

      if (pathname === '/' && request.method === 'GET') {
        html(hasSession ? CATALOG_HTML : LOGIN_HTML);
        return;
      }
      if (pathname === '/login' && request.method === 'POST') {
        // Credential submission by automation — the test asserts this never
        // happens. (A real user's browser would POST this form.)
        counters.loginPosts += 1;
        redirect('/', 'pl24session=ok');
        return;
      }
      if (pathname === '/login' && request.method === 'GET') {
        // Simulated human: the user finished signing in by hand.
        redirect('/', 'pl24session=ok');
        return;
      }
      if (pathname === '/search' && request.method === 'GET') {
        if (!hasSession) {
          redirect('/');
          return;
        }
        if (!captchaPassed) {
          html(CHALLENGE_HTML);
          return;
        }
        redirect(`/results?vin=${encodeURIComponent(requestUrl.searchParams.get('vin') ?? '')}`);
        return;
      }
      if (pathname === '/captcha-pass' && request.method === 'GET') {
        // Simulated human: the user solved the CAPTCHA by hand.
        redirect(
          `/results?vin=${encodeURIComponent(requestUrl.searchParams.get('vin') ?? '')}`,
          'pl24captcha=ok',
        );
        return;
      }
      if (pathname === '/results' && request.method === 'GET') {
        if (!hasSession) {
          redirect('/');
          return;
        }
        if (!captchaPassed) {
          html(CHALLENGE_HTML);
          return;
        }
        html(RESULTS_HTML);
        return;
      }
      if (pathname === '/recaptcha-frame') {
        html('<!doctype html><html><body>frame</body></html>');
        return;
      }
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        counters,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

function createCapturingLogger(): { logger: Logger; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  // Deliberately a RAW pino logger (no redaction config): anything the server
  // or the scenario logs lands here verbatim, so a VIN leak is visible.
  return { logger: pino(stream), text: () => chunks.join('') };
}

const hasChrome = findChromeExecutable() !== undefined;
const describeWithChrome = hasChrome ? describe : describe.skip;

describeWithChrome('Partslink24 end-to-end scenario (mock site, real Chrome + MCP)', () => {
  let chrome: TestChrome;
  let fixture: Fixture;
  let adapter: BrowserAdapter;
  let humanGate: HumanGate;
  let mcp: BrowserMcpServerHandle;
  let mcpHttp: McpHttpServerHandle;
  let client: Client;
  let capturing: { logger: Logger; text: () => string };
  let report: ScenarioReport;
  const handoffsSeen: ScenarioHandoff[] = [];

  beforeAll(async () => {
    chrome = await startTestChrome();
    fixture = await startFixture();
    capturing = createCapturingLogger();

    adapter = createBrowserAdapter({
      endpoint: chrome.endpoint,
      logger: capturing.logger,
      // The disposable test Chrome runs headless; visible-mode enforcement is
      // covered by the adapter integration tests.
      visibleModeRequired: false,
    });
    humanGate = createHumanGate();
    mcp = createBrowserMcpServer({
      adapter,
      domainPolicy: createDomainPolicy(['127.0.0.1']),
      humanGate,
      version: '0.1.0',
      logger: capturing.logger,
    });
    mcpHttp = await createMcpHttpServer({
      buildMcpServer: () => mcp.build(),
      listenHost: '127.0.0.1',
      listenPort: 0,
      logger: capturing.logger,
    });

    client = new Client({ name: 'partslink24-e2e', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${mcpHttp.port}/mcp`),
      ) as unknown as Transport,
    );

    const script: Partslink24Script = {
      startUrl: `${fixture.url}/`,
      search: {
        vinLocator: { kind: 'label', label: 'VIN' },
        submitLocator: { kind: 'role', role: 'button', name: 'Search' },
      },
      results: {
        waitLocator: { kind: 'css', selector: '#parts' },
        partNumberLocator: { kind: 'css', selector: '#parts .pn' },
        applicabilityLocator: { kind: 'css', selector: '#parts .appl' },
      },
    };

    report = await runPartslink24Scenario({
      call: async (tool, args) =>
        (await client.callTool({ name: tool, arguments: args ?? {} })) as ScenarioToolResult,
      waitForUser: async (handoff) => {
        handoffsSeen.push(handoff);
        // The simulated human acts with their own hands — direct tab control,
        // never through the MCP tools (which stay blocked while paused):
        if (handoff.kind === 'login') {
          // ...signs in manually (the fixture grants the session cookie).
          await adapter.navigate({ pageId: handoff.pageId, url: `${fixture.url}/login` });
        } else {
          // ...solves the CAPTCHA manually (the fixture grants the pass).
          await adapter.navigate({
            pageId: handoff.pageId,
            url: `${fixture.url}/captcha-pass?vin=${TEST_VIN}`,
          });
        }
      },
      vin: TEST_VIN,
      script,
      logger: capturing.logger,
    });
  }, 180_000);

  afterAll(async () => {
    await client?.close();
    await mcpHttp?.close();
    humanGate?.dispose();
    await adapter?.dispose();
    await fixture?.close();
    await chrome?.close();
  }, 60_000);

  it('completes the full scenario: login handoff, CAPTCHA handoff, extraction', () => {
    expect(report.ok).toBe(true);
    expect(report.errorCode).toBeUndefined();
    expect(report.partNumbers).toEqual(['06K103271B', '06K103271C']);
    expect(report.applicability).toEqual([
      'Golf VI 1.4 TSI (2008-2013)',
      'Polo V 1.2 TSI (2009-2017)',
    ]);
    expect(report.truncated).toBe(false);
  });

  it('hands over exactly twice: login first, then the CAPTCHA', () => {
    expect(report.handoffs.map((handoff) => handoff.kind)).toEqual(['login', 'challenge']);
    expect(handoffsSeen.map((handoff) => handoff.kind)).toEqual(['login', 'challenge']);
    // Each handoff finished in a single verified round.
    expect(report.handoffs.every((handoff) => handoff.rounds === 1)).toBe(true);
  });

  it('continues the SAME session on the SAME tab without re-login', () => {
    const pageIds = new Set(report.handoffs.map((handoff) => handoff.pageId));
    pageIds.add(report.pageId as string);
    expect(pageIds.size).toBe(1);
    // Exactly one tab was opened for the whole run; the cookie-based fixture
    // would have bounced the search/results back to the login wall otherwise.
    expect(report.steps.filter((step) => step.tool === 'page_open')).toHaveLength(1);
    expect(report.handoffs.filter((handoff) => handoff.kind === 'login')).toHaveLength(1);
  });

  it('never submits credentials and never reads the password field', () => {
    // The fixture counts POST /login (the credential form): automation must
    // never submit it — the user signed in via the simulated manual GET path.
    expect(fixture.counters.loginPosts).toBe(0);
    // No page_fill happened before the login handoff was over.
    const tools = report.steps.map((step) => step.tool);
    const firstFill = tools.indexOf('page_fill');
    const firstResume = tools.indexOf('human_resume');
    expect(firstFill).toBeGreaterThan(firstResume);
  });

  it('masks the VIN in the report and in every log line', () => {
    expect(report.vinMasked).toBe(TEST_VIN_MASKED);
    expect(JSON.stringify(report)).not.toContain(TEST_VIN);
    const logs = capturing.text();
    expect(logs).not.toContain(TEST_VIN);
    expect(logs).toContain(TEST_VIN_MASKED);
  });
});

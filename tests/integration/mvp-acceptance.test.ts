/**
 * Stage 10: MVP acceptance — session persistence and model-facing secrecy.
 *
 * Two MVP criteria get their direct mechanical proof here (real Chrome ->
 * BrowserAdapter -> human gate -> MCP over Streamable HTTP -> SDK client):
 *
 *  1. "An existing authenticated session is preserved": the user signs in
 *     manually BEFORE the automation server comes up; the server is then
 *     fully restarted (adapter disposed, a fresh adapter/MCP/client created)
 *     and the site still recognizes the session — no re-login, and Chrome
 *     keeps running across the restart.
 *  2. "Raw cookies and passwords are not accessible to the model": the raw
 *     session-cookie value and a password field value appear in NO tool
 *     output (snapshot/extract/status), and the MCP surface is exactly the
 *     closed set of 15 tools — no cookie/storage/eval capability exists.
 */
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  cdpIsAlive,
  findChromeExecutable,
  startTestChrome,
  type TestChrome,
} from '../helpers/test-chrome.js';

const COOKIE_VALUE = 'SECRET_COOKIE_9f8e7d6c5b4a';
const PASSWORD_VALUE = 'SECRET-PW-VALUE-12345';

const EXPECTED_TOOLS = [
  'browser_connect',
  'browser_status',
  'page_list',
  'page_open',
  'page_navigate',
  'page_close',
  'page_snapshot',
  'page_screenshot',
  'page_click',
  'page_fill',
  'page_select',
  'page_press',
  'page_wait',
  'page_extract',
  'human_required',
  'human_resume',
] as const;

const LOGIN_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sign in</title></head>
<body>
<h1>Sign in</h1>
<form method="post" action="/login">
  <label for="user">Username</label><input id="user" name="username">
  <label for="pass">Password</label><input id="pass" name="password" type="password">
  <button type="submit">Sign in</button>
</form>
</body>
</html>`;

const CATALOG_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Vehicle search</title></head>
<body>
<p id="greeting">Signed in. Welcome back.</p>
<form method="get" action="/search">
  <label for="vin">VIN</label><input id="vin" name="vin">
  <button type="submit">Search</button>
</form>
<form>
  <label for="pw">Password</label>
  <input id="pw" name="password" type="password" value="${PASSWORD_VALUE}">
</form>
</body>
</html>`;

interface Fixture {
  readonly url: string;
  readonly counters: { loginVisits: number; loginPosts: number };
  close(): Promise<void>;
}

async function startFixture(): Promise<Fixture> {
  const counters = { loginVisits: 0, loginPosts: 0 };
  return await new Promise((resolve, reject) => {
    const server: Server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', 'http://fixture.invalid');
      const pathname = requestUrl.pathname;
      const hasSession = (request.headers.cookie ?? '')
        .split(';')
        .some((part) => part.trim() === `mvp_session=${COOKIE_VALUE}`);

      const html = (body: string): void => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(body);
      };

      if (pathname === '/' && request.method === 'GET') {
        html(hasSession ? CATALOG_HTML : LOGIN_HTML);
        return;
      }
      if (pathname === '/login') {
        // Simulated human sign-in: the fixture grants the session cookie.
        if (request.method === 'GET') counters.loginVisits += 1;
        if (request.method === 'POST') counters.loginPosts += 1;
        response.writeHead(302, {
          location: '/',
          'set-cookie': `mvp_session=${COOKIE_VALUE}; Path=/`,
        });
        response.end();
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

const hasChrome = findChromeExecutable() !== undefined;
const describeWithChrome = hasChrome ? describe : describe.skip;

describeWithChrome('MVP acceptance (real Chrome + real MCP)', () => {
  let chrome: TestChrome;
  let fixture: Fixture;
  let firstAdapter: BrowserAdapter | undefined;
  let adapter: BrowserAdapter;
  let humanGate: HumanGate;
  let mcp: BrowserMcpServerHandle;
  let mcpHttp: McpHttpServerHandle;
  let client: Client;
  const logger: Logger = pino({ level: 'silent' });

  beforeAll(async () => {
    chrome = await startTestChrome();
    fixture = await startFixture();

    // --- The user's existing authenticated session, established BEFORE the
    // automation server exists: the user signs in by hand in Chrome (direct
    // adapter navigation stands in for the user's hands, as in Stage 9).
    firstAdapter = createBrowserAdapter({
      endpoint: chrome.endpoint,
      logger,
      visibleModeRequired: false,
    });
    await firstAdapter.connect();
    const wall = await firstAdapter.openPage({ url: `${fixture.url}/` });
    expect(wall.url).toBe(`${fixture.url}/`); // the login wall (no cookie yet)
    await firstAdapter.navigate({ pageId: wall.pageId, url: `${fixture.url}/login` });
    // The "server" now goes away entirely: dispose detaches, Chrome runs on.
    await firstAdapter.dispose();
    firstAdapter = undefined;
    expect(await cdpIsAlive(chrome.port)).toBe(true);

    // --- A full "server restart": brand-new adapter, gate, MCP server, client.
    adapter = createBrowserAdapter({
      endpoint: chrome.endpoint,
      logger,
      visibleModeRequired: false,
    });
    humanGate = createHumanGate();
    mcp = createBrowserMcpServer({
      adapter,
      domainPolicy: createDomainPolicy(['127.0.0.1']),
      humanGate,
      version: '0.1.0',
      logger,
    });
    mcpHttp = await createMcpHttpServer({
      buildMcpServer: () => mcp.build(),
      listenHost: '127.0.0.1',
      listenPort: 0,
      logger,
    });
    client = new Client({ name: 'mvp-acceptance', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${mcpHttp.port}/mcp`),
      ) as unknown as Transport,
    );
  }, 180_000);

  afterAll(async () => {
    await client?.close();
    await mcpHttp?.close();
    humanGate?.dispose();
    await adapter?.dispose();
    await firstAdapter?.dispose();
    await fixture?.close();
    await chrome?.close();
  }, 60_000);

  it('the MCP surface is exactly the closed 15-tool set (no cookie/storage/eval tools)', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const tool of tools) {
      // No tool NAME grants access to cookies, storage, tokens or JS execution
      // (tool descriptions only ever mention these to forbid them).
      expect(tool.name).not.toMatch(/cookie|storage|token|eval|script|exec/i);
    }
  }, 60_000);

  it('the existing authenticated session survives a server restart without re-login', async () => {
    const connect = await client.callTool({ name: 'browser_connect', arguments: {} });
    expect((connect.structuredContent as Record<string, unknown>).connected).toBe(true);

    const list = await client.callTool({ name: 'page_list', arguments: {} });
    const pages = (list.structuredContent as Record<string, unknown>).pages as Array<{
      pageId: string;
      url: string;
    }>;
    const tab = pages.find((page) => page.url.startsWith(fixture.url));
    expect(tab).toBeDefined();

    // Reload the start page through MCP: the site must recognize the session.
    const navigated = await client.callTool({
      name: 'page_navigate',
      arguments: { pageId: tab?.pageId, url: `${fixture.url}/` },
    });
    expect(navigated.isError).toBeUndefined();
    const snapshot = await client.callTool({
      name: 'page_snapshot',
      arguments: { pageId: tab?.pageId },
    });
    const text = (snapshot.structuredContent as Record<string, unknown>).snapshot as string;
    // The catalog (signed-in) page, not the login wall.
    expect(text).toContain('Signed in');
    expect(text).toContain('textbox "VIN"');
    expect(text).not.toContain('Sign in');

    // The only sign-in ever was the manual one BEFORE the restart.
    expect(fixture.counters.loginVisits).toBe(1);
    expect(fixture.counters.loginPosts).toBe(0);
  }, 60_000);

  it('raw cookie and password values never reach the model', async () => {
    const list = await client.callTool({ name: 'page_list', arguments: {} });
    const pages = (list.structuredContent as Record<string, unknown>).pages as Array<{
      pageId: string;
      url: string;
    }>;
    const pageId = pages.find((page) => page.url.startsWith(fixture.url))?.pageId;
    expect(pageId).toBeDefined();

    const outputs: string[] = [];

    const snapshot = await client.callTool({ name: 'page_snapshot', arguments: { pageId } });
    const snapshotText = (snapshot.structuredContent as Record<string, unknown>).snapshot as string;
    outputs.push(snapshotText);
    // The password field is present but masked.
    expect(snapshotText).toContain('[REDACTED]');

    const bodyExtract = await client.callTool({
      name: 'page_extract',
      arguments: { pageId },
    });
    outputs.push(JSON.stringify(bodyExtract.structuredContent ?? {}));

    const passwordExtract = await client.callTool({
      name: 'page_extract',
      arguments: { pageId, locator: { kind: 'css', selector: '#pw' } },
    });
    const passwordItems = (passwordExtract.structuredContent as Record<string, unknown>)
      .items as string[];
    outputs.push(JSON.stringify(passwordItems));
    expect(passwordItems).toEqual(['[REDACTED]']);

    const status = await client.callTool({ name: 'browser_status', arguments: {} });
    outputs.push(JSON.stringify(status.structuredContent ?? {}));

    for (const output of outputs) {
      expect(output).not.toContain(COOKIE_VALUE);
      expect(output).not.toContain(PASSWORD_VALUE);
    }
  }, 60_000);
});

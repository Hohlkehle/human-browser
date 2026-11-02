/**
 * Stage 5 integration tests: MCP server over Streamable HTTP with a real
 * SDK client, the real BrowserAdapter and a real disposable Chrome. Skipped
 * entirely when no Chrome executable is found on the machine.
 *
 * The domain allowlist for this test is `127.0.0.1` (the local fixture
 * server); every other host must be refused by `page_navigate`/`page_open`.
 */
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowserAdapter, type BrowserAdapter } from '../../src/browser/adapter.js';
import { createHumanGate } from '../../src/human/gate.js';
import { createMcpHttpServer, type McpHttpServerHandle } from '../../src/mcp/http.js';
import { createBrowserMcpServer, type BrowserMcpServerHandle } from '../../src/mcp/server.js';
import { createDomainPolicy } from '../../src/policy/domains.js';
import { findChromeExecutable, startTestChrome, type TestChrome } from '../helpers/test-chrome.js';

const FORM_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>MCP Fixture</title></head>
<body>
<h1>Form</h1>
<label for="u">Username</label><input id="u" name="username">
<label for="p">Password</label><input id="p" name="password" type="password" value="hunter2secret">
<label for="country">Country</label>
<select id="country">
  <option value="de">Germany</option>
  <option value="us">United States</option>
</select>
<button id="go" type="button">Submit</button>
<span id="clicks">clicks:0</span>
<ul id="list"><li>alpha</li><li>beta</li><li>gamma</li></ul>
<div id="late" hidden>appeared</div>
<script>
  let n = 0;
  document.getElementById('go').addEventListener('click', () => {
    n += 1;
    document.getElementById('clicks').textContent = 'clicks:' + n;
  });
  setTimeout(() => { document.getElementById('late').hidden = false; }, 700);
</script>
</body>
</html>`;

const SECOND_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Second Page</title></head>
<body><h1>Second</h1><p>secondary content</p></body>
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

const hasChrome = findChromeExecutable() !== undefined;
const describeWithChrome = hasChrome ? describe : describe.skip;

describeWithChrome('MCP server over Streamable HTTP (real Chrome)', () => {
  let chrome: TestChrome;
  let fixture: { url: string; close(): Promise<void> };
  let adapter: BrowserAdapter;
  let mcp: BrowserMcpServerHandle;
  let mcpHttp: McpHttpServerHandle;
  let client: Client;
  let pageId: string;

  beforeAll(async () => {
    chrome = await startTestChrome();

    fixture = await new Promise((resolve, reject) => {
      const server: Server = http.createServer((request, response) => {
        const pathname = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
        if (pathname === '/form') {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          response.end(FORM_HTML);
          return;
        }
        if (pathname === '/second') {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          response.end(SECOND_HTML);
          return;
        }
        if (pathname === '/challenge') {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          response.end(CHALLENGE_HTML);
          return;
        }
        if (pathname === '/recaptcha-frame') {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          response.end('<!doctype html><html><body>frame</body></html>');
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
          close: () =>
            new Promise<void>((done) => {
              server.close(() => done());
              server.closeAllConnections();
            }),
        });
      });
    });

    adapter = createBrowserAdapter({
      endpoint: chrome.endpoint,
      logger: pino({ level: 'silent' }),
      // The disposable test Chrome runs headless; visible-mode enforcement is
      // covered by the adapter integration tests.
      visibleModeRequired: false,
    });
    mcp = createBrowserMcpServer({
      adapter,
      domainPolicy: createDomainPolicy(['127.0.0.1']),
      humanGate: createHumanGate(),
      version: '0.1.0',
      logger: pino({ level: 'silent' }),
    });
    mcpHttp = await createMcpHttpServer({
      buildMcpServer: () => mcp.build(),
      listenHost: '127.0.0.1',
      listenPort: 0,
      logger: pino({ level: 'silent' }),
    });

    client = new Client({ name: 'mcp-http-integration', version: '0.0.0' });
    // The SDK's client transport types do not satisfy our
    // `exactOptionalPropertyTypes` view of the Transport interface; the
    // runtime contract is identical.
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${mcpHttp.port}/mcp`),
      ) as unknown as Transport,
    );
  }, 90_000);

  afterAll(async () => {
    await client?.close();
    await mcpHttp?.close();
    await adapter?.dispose();
    await fixture?.close();
    await chrome?.close();
  }, 60_000);

  function structured(result: CallToolResult): Record<string, unknown> {
    return (result.structuredContent ?? {}) as Record<string, unknown>;
  }

  async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  }

  it('lists all 16 tools through the HTTP transport', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'browser_connect',
      'browser_status',
      'human_required',
      'human_resume',
      'page_click',
      'page_close',
      'page_extract',
      'page_fill',
      'page_list',
      'page_navigate',
      'page_open',
      'page_press',
      'page_screenshot',
      'page_select',
      'page_snapshot',
      'page_wait',
    ]);
  });

  it('connects to Chrome', async () => {
    const result = await call('browser_connect');
    expect(result.isError).toBeFalsy();
    expect(structured(result).connected).toBe(true);
  });

  it('opens an allowlisted page and snapshots it redacted', async () => {
    const opened = await call('page_open', { url: `${fixture.url}/form` });
    expect(opened.isError).toBeFalsy();
    pageId = structured(opened).pageId as string;
    expect(pageId).toMatch(/^page-\d+$/);

    const snapshot = await call('page_snapshot', { pageId });
    expect(snapshot.isError).toBeFalsy();
    const text = structured(snapshot).snapshot as string;
    expect(text).toContain('Username');
    // The password field value must never leave the server.
    expect(text).not.toContain('hunter2secret');
    expect(text).toContain('[REDACTED]');
  }, 60_000);

  it('blocks navigation to a domain outside the allowlist', async () => {
    const result = await call('page_navigate', { pageId, url: 'https://blocked.example/' });
    expect(result.isError).toBe(true);
    const error = structured(result).error as { code: string };
    expect(error.code).toBe('domain_forbidden');

    // The tab must still be on the fixture page.
    const pages = await call('page_list');
    const list = structured(pages).pages as Array<{ pageId: string; url: string }>;
    expect(list.find((page) => page.pageId === pageId)?.url).toContain('127.0.0.1');
  });

  it('blocks opening a new tab on a forbidden domain', async () => {
    const result = await call('page_open', { url: 'https://blocked.example/' });
    expect(result.isError).toBe(true);
    expect((structured(result).error as { code: string }).code).toBe('domain_forbidden');
  });

  it('closes an automation-opened tab and refuses to close the user’s own', async () => {
    // A tab this automation opened is closed directly.
    const opened = await call('page_open', { url: `${fixture.url}/form` });
    const owned = structured(opened).pageId as string;
    const listed = await call('page_list');
    const ownedInfo = (structured(listed).pages as Array<{ pageId: string; openedByAdapter?: boolean }>)
      .find((page) => page.pageId === owned);
    expect(ownedInfo?.openedByAdapter).toBe(true);

    const closed = await call('page_close', { pageId: owned });
    expect(closed.isError).toBeFalsy();
    expect(structured(closed)).toMatchObject({ pageId: owned, closed: true });
    expect(structured(closed).remainingTabs).toBeGreaterThan(0);

    // A tab that existed before the automation (the browser's own tab) is NOT
    // ours: closing it demands a single-use token from the user.
    const userTab = (structured(await call('page_list')).pages as Array<{
      pageId: string;
      openedByAdapter?: boolean;
    }>).find((page) => page.openedByAdapter === false);
    expect(userTab).toBeTruthy();
    // Guard: never close the fixture tab the other tests still use.
    expect(userTab!.pageId).not.toBe(pageId);

    const refused = await call('page_close', { pageId: userTab!.pageId });
    expect(refused.isError).toBe(true);
    expect((structured(refused).error as { code: string }).code).toBe('confirmation_required');
    expect(structured(refused).sensitiveAction).toBe('tab_close');
    const token = structured(refused).confirmToken as string;
    expect(token).toMatch(/^[0-9a-f]{32}$/);

    // The user approved: the tab goes away with the token.
    const confirmed = await call('page_close', { pageId: userTab!.pageId, confirmToken: token });
    expect(confirmed.isError).toBeFalsy();
    expect(structured(confirmed).closed).toBe(true);
  }, 60_000);

  it('refuses to fill a password field', async () => {
    const result = await call('page_fill', {
      pageId,
      locator: { kind: 'label', label: 'Password' },
      value: 'attempted-secret',
    });
    expect(result.isError).toBe(true);
    const error = structured(result).error as { code: string; message: string };
    expect(error.code).toBe('sensitive_field_forbidden');
    expect(JSON.stringify(result)).not.toContain('attempted-secret');
  });

  it('fills, clicks, selects, presses and waits', async () => {
    const filled = await call('page_fill', {
      pageId,
      locator: { kind: 'label', label: 'Username' },
      value: 'alice',
    });
    expect(filled.isError).toBeFalsy();

    const clicked = await call('page_click', {
      pageId,
      locator: { kind: 'role', role: 'button', name: 'Submit' },
    });
    expect(clicked.isError).toBeFalsy();

    const clicks = await call('page_extract', {
      pageId,
      locator: { kind: 'css', selector: '#clicks' },
    });
    expect(structured(clicks).items).toEqual(['clicks:1']);

    const selected = await call('page_select', {
      pageId,
      locator: { kind: 'css', selector: '#country' },
      label: 'Germany',
    });
    expect(selected.isError).toBeFalsy();
    expect(structured(selected).selectedValues).toEqual(['de']);

    const pressed = await call('page_press', { pageId, key: 'Tab' });
    expect(pressed.isError).toBeFalsy();

    const waited = await call('page_wait', {
      pageId,
      locator: { kind: 'css', selector: '#late' },
      state: 'visible',
      timeoutMs: 10_000,
    });
    expect(waited.isError).toBeFalsy();
  }, 90_000);

  it('extracts list items and navigates within the allowlist', async () => {
    const items = await call('page_extract', {
      pageId,
      locator: { kind: 'css', selector: '#list li' },
    });
    expect(structured(items).items).toEqual(['alpha', 'beta', 'gamma']);

    const navigated = await call('page_navigate', { pageId, url: `${fixture.url}/second` });
    expect(navigated.isError).toBeFalsy();
    expect(structured(navigated).title).toBe('Second Page');

    const body = await call('page_extract', { pageId });
    expect((structured(body).items as string[])[0]).toContain('secondary content');
  }, 60_000);

  it('returns a PNG screenshot as an image block', async () => {
    const result = await call('page_screenshot', { pageId });
    expect(result.isError).toBeFalsy();
    const block = result.content[0] as { type: string; data: string; mimeType: string };
    expect(block.type).toBe('image');
    expect(block.mimeType).toBe('image/png');
    const bytes = Buffer.from(block.data, 'base64');
    // PNG magic number.
    expect(bytes.subarray(0, 4).toString('hex')).toBe('89504e47');
    expect(structured(result).sizeBytes as number).toBeGreaterThan(0);
  }, 60_000);

  it('pauses all page_* tools on human_required and resumes on human_resume', async () => {
    const pause = await call('human_required', { reason: 'CAPTCHA check', pageId });
    expect(pause.isError).toBeFalsy();
    expect(structured(pause).state).toBe('waiting_for_user');
    expect(structured(pause).hostname).toBe('127.0.0.1');

    const blocked = await call('page_snapshot', { pageId });
    expect(blocked.isError).toBe(true);
    expect((structured(blocked).error as { code: string }).code).toBe('human_required');

    const blockedRead = await call('page_extract', { pageId });
    expect(blockedRead.isError).toBe(true);

    const resumed = await call('human_resume');
    expect(structured(resumed).resumed).toBe(true);

    const after = await call('page_snapshot', { pageId });
    expect(after.isError).toBeFalsy();
  }, 60_000);

  it('Stage 6: auto-detects a CAPTCHA, blocks until a verified resume, then continues on the same tab', async () => {
    // Navigating onto a challenge page pauses automation automatically.
    const nav = await call('page_navigate', { pageId, url: `${fixture.url}/challenge` });
    expect(nav.isError).toBe(true);
    const navError = structured(nav).error as {
      code: string;
      message: string;
      pageId?: string;
    };
    expect(navError.code).toBe('captcha_detected');
    expect(navError.pageId).toBe(pageId);
    // Safe explanation: provider + hostname, never page content or URL paths.
    expect(navError.message).toContain('127.0.0.1');
    expect(navError.message).not.toContain('/recaptcha-frame');
    expect(navError.message).not.toContain('/challenge');

    // Every page_* tool is blocked while the user works.
    const blocked = await call('page_snapshot', { pageId });
    expect((structured(blocked).error as { code: string }).code).toBe('human_required');

    // Premature resume: the challenge is still on screen -> rejected.
    const premature = await call('human_resume');
    expect(premature.isError).toBe(true);
    expect((structured(premature).error as { code: string }).code).toBe(
      'challenge_still_present',
    );

    // The user completes the challenge in the visible Chrome (simulated by a
    // direct adapter navigation — the tools themselves stay blocked).
    await adapter.navigate({ pageId, url: `${fixture.url}/second` });

    // Now the verified resume succeeds and automation continues on the SAME tab.
    const resumed = await call('human_resume');
    expect(resumed.isError).toBeFalsy();
    expect(structured(resumed).resumed).toBe(true);

    const after = await call('page_snapshot', { pageId });
    expect(after.isError).toBeFalsy();
    expect(structured(after).snapshot).toContain('Second');
  }, 90_000);

  it('reports not_connected errors as structured and retryable after disconnect', async () => {
    await adapter.disconnect();
    const result = await call('page_list');
    expect(result.isError).toBe(true);
    const error = structured(result).error as { code: string; retryable: boolean };
    expect(error.code).toBe('not_connected');
    expect(error.retryable).toBe(true);

    // And browser_connect recovers the session.
    const reconnected = await call('browser_connect');
    expect(reconnected.isError).toBeFalsy();
    expect(structured(reconnected).connected).toBe(true);
  }, 60_000);
});

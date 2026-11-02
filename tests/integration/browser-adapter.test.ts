/**
 * Stage 4 integration tests: BrowserAdapter against a real disposable Chrome
 * (private temp profile, remote debugging on loopback). Skipped entirely when
 * no Chrome executable is found on the machine.
 */
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BrowserAdapterError,
  createBrowserAdapter,
  type BrowserAdapter,
  type BrowserAdapterOptions,
} from '../../src/browser/adapter.js';
import { createCdpGateway, type CdpGatewayHandle } from '../../src/cdp/gateway.js';
import {
  cdpGet,
  cdpIsAlive,
  findChromeExecutable,
  startTestChrome,
  type TestChrome,
} from '../helpers/test-chrome.js';

const GATEWAY_TOKEN = 'adapter-integration-token-1234567890';

const FORM_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Adapter Fixture</title></head>
<body>
<h1>Form</h1>
<label for="u">Username</label><input id="u" name="username">
<label for="p">Password</label><input id="p" name="password" type="password" value="hunter2secret">
<label for="ac">Login code</label><input id="ac" type="text" autocomplete="current-password">
<label for="c">Card number</label><input id="c" name="card" value="4111 1111 1111 1111">
<label for="country">Country</label>
<select id="country">
  <option value="de">Germany</option>
  <option value="us">United States</option>
</select>
<button id="go" type="button">Submit</button>
<button id="aria-buy" type="button" aria-label="Buy now"></button>
<span id="clicks">clicks:0</span>
<ul id="list"><li>alpha</li><li>beta</li><li>gamma</li></ul>
<div id="late" hidden>appeared</div>
<script>
  let n = 0;
  document.getElementById('go').addEventListener('click', () => {
    n += 1;
    document.getElementById('clicks').textContent = 'clicks:' + n;
  });
  setTimeout(() => {
    document.getElementById('late').hidden = false;
  }, 700);
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

interface Fixture {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

function startFixtureServer(): Promise<Fixture> {
  return new Promise((resolve, reject) => {
    const server: Server = http.createServer((request, response) => {
      let pathname = '/';
      try {
        pathname = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
      } catch {
        /* keep default */
      }
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
        // A fast, local stand-in for a provider widget frame; the frame URL is
        // what the detector sees, so no external network request is involved.
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
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            // Chrome keeps HTTP keep-alive sockets open; drop them so close()
            // does not wait for the browser to release them.
            server.closeAllConnections();
          }),
      });
    });
  });
}

function cdpRequest(
  port: number,
  method: string,
  urlPath: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: urlPath, method }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<BrowserAdapterError> {
  try {
    await fn();
  } catch (error) {
    expect(error, `expected code "${code}"`).toBeInstanceOf(BrowserAdapterError);
    expect((error as BrowserAdapterError).code).toBe(code);
    return error as BrowserAdapterError;
  }
  throw new Error(`expected BrowserAdapterError(${code}) but no error was thrown`);
}

const chromePath = findChromeExecutable();

describe.skipIf(!chromePath)('BrowserAdapter against a test Chrome', () => {
  let chrome: TestChrome;
  let fixture: Fixture;
  const adapters: BrowserAdapter[] = [];

  beforeAll(async () => {
    chrome = await startTestChrome();
    fixture = await startFixtureServer();
  }, 60_000);

  afterAll(async () => {
    while (adapters.length > 0) {
      const adapter = adapters.pop() as BrowserAdapter;
      await adapter.dispose().catch(() => undefined);
    }
    if (fixture) await fixture.close();
    if (chrome) await chrome.close();
  }, 60_000);

  // Every `newAdapter()` opens its own CDP session, and `disconnect()` only
  // detaches — it never closes tabs. Left alone, tabs accumulate (~18 by the
  // last tests) and `connectOverCDP` gets slower with each one, because
  // Playwright attaches to every existing page on connect, until connect/open
  // blow the per-test budget. No test reuses a previous test's adapter or its
  // tabs, so after each case we drop the adapters and close all but one tab
  // (one stays so the default context is never empty). Chrome keeps running.
  afterEach(async () => {
    while (adapters.length > 0) {
      const adapter = adapters.pop() as BrowserAdapter;
      await adapter.dispose().catch(() => undefined);
    }
    try {
      const list = await cdpGet(chrome.port, '/json/list');
      const targets = JSON.parse(list.body) as Array<{ id: string; type: string }>;
      const pages = targets.filter((target) => target.type === 'page');
      for (const target of pages.slice(1)) {
        await cdpGet(chrome.port, `/json/close/${target.id}`).catch(() => undefined);
      }
    } catch {
      // Best effort only: a failed cleanup must not mask the test result.
    }
  }, 30_000);

  async function newAdapter(
    overrides: Partial<BrowserAdapterOptions> = {},
  ): Promise<BrowserAdapter> {
    const adapter = createBrowserAdapter({
      endpoint: chrome.endpoint,
      // Tests open many tabs across cases; the tab-limit test sets its own.
      maxTabs: 100,
      // The disposable test Chrome runs headless; visible-mode enforcement is
      // covered by its own dedicated test below.
      visibleModeRequired: false,
      ...overrides,
    });
    adapters.push(adapter);
    await adapter.connect();
    return adapter;
  }

  async function openForm(adapter: BrowserAdapter): Promise<string> {
    const page = await adapter.openPage({ url: `${fixture.url}/form` });
    return page.pageId;
  }

  it('connects and reports status', async () => {
    const adapter = await newAdapter();
    expect(adapter.isConnected()).toBe(true);
    const status = adapter.status();
    expect(status.connected).toBe(true);
    expect(status.endpoint).toBe(chrome.endpoint);
    expect(status.browserVersion).toMatch(/\d+\.\d+/);
    expect(status.protocolVersion).toBe('1.3');
    expect(status.tabs).toBeGreaterThan(0);
    // The endpoint carries no path or credentials in status output.
    expect(status.endpoint).not.toContain('/devtools/');
  }, 30_000);

  it('assigns stable pageIds and picks up tabs opened outside Playwright', async () => {
    const adapter = await newAdapter();
    const opened = await adapter.openPage();
    const first = await adapter.listPages();
    const second = await adapter.listPages();
    expect(second).toEqual(first);
    expect(first.map((page) => page.pageId)).toContain(opened.pageId);
    expect(new Set(first.map((page) => page.pageId)).size).toBe(first.length);
    for (const page of first) {
      expect(page.contextId).toMatch(/^ctx-\d+$/);
    }

    // A tab opened directly through Chrome CDP must appear with its own id.
    const before = first.length;
    const created = await cdpRequest(chrome.port, 'PUT', '/json/new?about:blank');
    expect(created.status).toBe(200);
    await vi.waitFor(
      async () => {
        const pages = await adapter.listPages();
        expect(pages.length).toBe(before + 1);
      },
      { timeout: 5_000 },
    );
    const after = await adapter.listPages();
    expect(new Set(after.map((page) => page.pageId)).size).toBe(after.length);
  }, 30_000);

  it('closes a tab it opened and reports the remaining tabs', async () => {
    const adapter = await newAdapter();
    const opened = await adapter.openPage({ url: `${fixture.url}/second` });
    const before = await adapter.listPages();
    // Ownership is per tab: ours is flagged, the browser's own tab is not.
    expect(before.find((page) => page.pageId === opened.pageId)?.openedByAdapter).toBe(true);
    for (const page of before.filter((entry) => entry.pageId !== opened.pageId)) {
      expect(page.openedByAdapter).toBe(false);
    }

    const result = await adapter.closePage({ pageId: opened.pageId });
    expect(result).toMatchObject({
      pageId: opened.pageId,
      closed: true,
      url: `${fixture.url}/second`,
    });
    expect(result.remainingTabs).toBe(before.length - 1);

    const after = await adapter.listPages();
    expect(after.map((page) => page.pageId)).not.toContain(opened.pageId);
    expect(after.length).toBe(before.length - 1);
    // Closing an already-closed tab is a typed error, never a crash.
    await expectCode(() => adapter.closePage({ pageId: opened.pageId }), 'unknown_page');
  }, 30_000);

  it('refuses to close the last open tab and leaves it usable', async () => {
    const adapter = await newAdapter();
    const pages = await adapter.listPages();
    for (const page of pages.slice(1)) {
      await adapter.closePage({ pageId: page.pageId });
    }
    const remaining = await adapter.listPages();
    expect(remaining.length).toBe(1);

    await expectCode(
      () => adapter.closePage({ pageId: remaining[0]!.pageId }),
      'last_tab_forbidden',
    );
    const stillThere = await adapter.listPages();
    expect(stillThere.length).toBe(1);
    expect(stillThere[0]!.pageId).toBe(remaining[0]!.pageId);
  }, 30_000);

  it('reports an unknown pageId for page_close', async () => {
    const adapter = await newAdapter();
    await expectCode(() => adapter.closePage({ pageId: 'page-999' }), 'unknown_page');
  }, 30_000);

  it('navigates and redacts sensitive fields in snapshots', async () => {
    const adapter = await newAdapter();
    const pageId = await openForm(adapter);

    await adapter.fill({
      pageId,
      locator: { kind: 'label', label: 'Username' },
      value: 'john_doe',
    });
    const snapshot = await adapter.snapshot({ pageId });

    expect(snapshot).toContain('- heading "Form" [level=1]');
    expect(snapshot).toContain('john_doe');
    expect(snapshot).toContain('[REDACTED]');
    expect(snapshot).not.toContain('hunter2secret');
    expect(snapshot).not.toContain('4111');

    const info = await adapter.navigate({ pageId, url: `${fixture.url}/second` });
    expect(info.url).toBe(`${fixture.url}/second`);
    expect(info.title).toBe('Second Page');
    expect(await adapter.snapshot({ pageId })).toContain('Second');
  }, 30_000);

  it('rejects navigation to non-http schemes and credential URLs', async () => {
    const adapter = await newAdapter();
    const pageId = await openForm(adapter);
    await expectCode(
      () => adapter.navigate({ pageId, url: 'file:///C:/Windows/win.ini' }),
      'invalid_argument',
    );
    await expectCode(
      () => adapter.navigate({ pageId, url: 'http://user:pass@127.0.0.1/x' }),
      'invalid_argument',
    );
  }, 30_000);

  it('returns a PNG screenshot', async () => {
    const adapter = await newAdapter();
    const pageId = await openForm(adapter);
    const buffer = await adapter.screenshot({ pageId });
    expect(buffer.byteLength).toBeGreaterThan(100);
    expect(buffer.subarray(1, 4).toString('ascii')).toBe('PNG');
  }, 30_000);

  it('clicks by role and by CSS', async () => {
    const adapter = await newAdapter();
    const pageId = await openForm(adapter);

    await adapter.click({ pageId, locator: { kind: 'role', role: 'button', name: 'Submit' } });
    let extracted = await adapter.extract({
      pageId,
      locator: { kind: 'css', selector: '#clicks' },
    });
    expect(extracted.items).toEqual(['clicks:1']);

    await adapter.click({ pageId, locator: { kind: 'css', selector: '#go' } });
    extracted = await adapter.extract({ pageId, locator: { kind: 'css', selector: '#clicks' } });
    expect(extracted.items).toEqual(['clicks:2']);
  }, 30_000);

  it('fills fields but refuses password fields', async () => {
    const adapter = await newAdapter();
    const pageId = await openForm(adapter);

    await adapter.fill({ pageId, locator: { kind: 'label', label: 'Username' }, value: 'jane' });
    const snapshot = await adapter.snapshot({ pageId });
    expect(snapshot).toContain('- textbox "Username": jane');

    await expectCode(
      () => adapter.fill({ pageId, locator: { kind: 'label', label: 'Password' }, value: 'oops' }),
      'sensitive_field_forbidden',
    );
    // autocomplete=current-password is treated as a password field too.
    await expectCode(
      () => adapter.fill({ pageId, locator: { kind: 'css', selector: '#ac' }, value: 'oops' }),
      'sensitive_field_forbidden',
    );
    // The prefilled secret never leaked into the snapshot along the way.
    expect(snapshot).not.toContain('hunter2secret');
  }, 30_000);

  it('selects options by label', async () => {
    const adapter = await newAdapter();
    const pageId = await openForm(adapter);
    const selected = await adapter.selectOption({
      pageId,
      locator: { kind: 'label', label: 'Country' },
      label: 'United States',
    });
    expect(selected).toEqual(['us']);
    const snapshot = await adapter.snapshot({ pageId });
    expect(snapshot).toContain('option "United States" [selected]');
  }, 30_000);

  it('presses keys on a locator', async () => {
    const adapter = await newAdapter();
    const pageId = await openForm(adapter);
    await adapter.press({ pageId, locator: { kind: 'css', selector: '#u' }, key: 'a' });
    const snapshot = await adapter.snapshot({ pageId });
    expect(snapshot).toContain('- textbox "Username": a');
    await expectCode(
      () => adapter.press({ pageId, key: 'bad key with spaces' }),
      'invalid_argument',
    );
  }, 30_000);

  it('waits for elements and load states, and times out cleanly', async () => {
    const adapter = await newAdapter();
    const pageId = await openForm(adapter);
    // #late becomes visible ~700ms after load.
    await adapter.wait({
      pageId,
      locator: { kind: 'css', selector: '#late' },
      state: 'visible',
      timeoutMs: 10_000,
    });
    const extracted = await adapter.extract({
      pageId,
      locator: { kind: 'css', selector: '#late' },
    });
    expect(extracted.items).toEqual(['appeared']);

    await adapter.wait({ pageId, loadState: 'load', timeoutMs: 5_000 });

    await expectCode(
      () => adapter.wait({ pageId, locator: { kind: 'css', selector: '#never' }, timeoutMs: 300 }),
      'timeout',
    );
    await expectCode(() => adapter.wait({ pageId }), 'invalid_argument');
  }, 30_000);

  it('honours AbortSignal on long operations', async () => {
    const adapter = await newAdapter();
    const pageId = await openForm(adapter);
    const controller = new AbortController();
    const waiting = adapter.wait({
      pageId,
      locator: { kind: 'css', selector: '#never' },
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 150);
    await expectCode(() => waiting, 'aborted');
  }, 30_000);

  it('extracts visible text with limits and password redaction', async () => {
    const adapter = await newAdapter();
    const pageId = await openForm(adapter);

    const items = await adapter.extract({ pageId, locator: { kind: 'css', selector: '#list li' } });
    expect(items.items).toEqual(['alpha', 'beta', 'gamma']);
    expect(items.truncated).toBe(false);
    expect(items.title).toBe('Adapter Fixture');

    const secret = await adapter.extract({ pageId, locator: { kind: 'css', selector: '#p' } });
    expect(secret.items).toEqual(['[REDACTED]']);

    const capped = await adapter.extract({
      pageId,
      locator: { kind: 'css', selector: '#list li' },
      timeoutMs: 10_000,
    });
    expect(capped.items.length).toBe(3);

    const page = await adapter.extract({ pageId });
    expect(page.items[0]).toContain('Form');
    expect(page.url).toBe(`${fixture.url}/form`);
  }, 30_000);

  it('extract respects maxExtractItems', async () => {
    const adapter = await newAdapter({ maxExtractItems: 2 });
    const pageId = await openForm(adapter);
    const result = await adapter.extract({
      pageId,
      locator: { kind: 'css', selector: '#list li' },
    });
    expect(result.items).toEqual(['alpha', 'beta']);
    expect(result.truncated).toBe(true);
  }, 30_000);

  it('enforces the tab limit', async () => {
    const adapter = await newAdapter();
    const current = (await adapter.listPages()).length;
    const limited = createBrowserAdapter({
      endpoint: chrome.endpoint,
      maxTabs: current + 1,
      visibleModeRequired: false,
    });
    adapters.push(limited);
    await limited.connect();
    await limited.openPage();
    await expectCode(() => limited.openPage(), 'tab_limit_exceeded');
  }, 30_000);

  it('rejects operations beyond the concurrency queue', async () => {
    const adapter = await newAdapter({ maxConcurrentOperations: 1, maxQueuedOperations: 1 });
    const pageId = await openForm(adapter);
    // Fresh navigation: #late is hidden again for ~700ms, so each wait holds
    // its semaphore slot long enough for the queue to overflow.
    await adapter.navigate({ pageId, url: `${fixture.url}/form` });

    const waitOnce = (): Promise<void> =>
      adapter.wait({
        pageId,
        locator: { kind: 'css', selector: '#late' },
        timeoutMs: 10_000,
      });
    const results = await Promise.allSettled([waitOnce(), waitOnce(), waitOnce(), waitOnce()]);
    const rejected = results.filter((result) => result.status === 'rejected');
    const codes = rejected.map((result) => (result.reason as BrowserAdapterError).code);
    expect(codes).toContain('too_many_operations');
    expect(rejected.length).toBe(2);
  }, 30_000);

  it('fails with typed errors for unknown pages', async () => {
    const adapter = await newAdapter();
    await expectCode(() => adapter.snapshot({ pageId: 'page-99999' }), 'unknown_page');
    await expectCode(
      () => adapter.click({ pageId: 'page-99999', locator: { kind: 'css', selector: 'body' } }),
      'unknown_page',
    );
  }, 30_000);

  it('handles a tab closed outside the adapter', async () => {
    const adapter = await newAdapter();
    // A unique URL so /json/list matching never confuses this tab with others.
    const tabUrl = `${fixture.url}/second?tab=close-test`;
    const info = await adapter.openPage({ url: tabUrl });

    const list = await cdpGet(chrome.port, '/json/list');
    const targets = JSON.parse(list.body) as Array<{ id: string; url: string; type: string }>;
    const target = targets.find((entry) => entry.url === tabUrl);
    expect(target).toBeDefined();
    const closed = await cdpGet(chrome.port, `/json/close/${target?.id}`);
    expect(closed.status).toBe(200);

    await vi.waitFor(
      async () => {
        const pages = await adapter.listPages();
        expect(pages.map((page) => page.pageId)).not.toContain(info.pageId);
      },
      { timeout: 5_000 },
    );

    await expectCode(() => adapter.snapshot({ pageId: info.pageId }), 'unknown_page');
  }, 30_000);

  it('disconnect leaves Chrome and its tabs running, then reconnects', async () => {
    const adapter = await newAdapter();
    const pageId = await openForm(adapter);
    const tabsBefore = (await cdpGet(chrome.port, '/json/list')).body;
    expect(tabsBefore).toContain(`${fixture.url}/form`);

    await adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);

    // Chrome is still alive and the tab survived the disconnect.
    expect(await cdpIsAlive(chrome.port)).toBe(true);
    const tabsAfter = (await cdpGet(chrome.port, '/json/list')).body;
    expect(tabsAfter).toContain(`${fixture.url}/form`);

    await expectCode(() => adapter.listPages(), 'not_connected');

    // Reconnect to the same running Chrome.
    await adapter.connect();
    expect(adapter.isConnected()).toBe(true);
    const pages = await adapter.listPages();
    expect(pages.some((page) => page.url === `${fixture.url}/form`)).toBe(true);
    // The old pageId belongs to the previous connection and is not reused.
    await expectCode(() => adapter.snapshot({ pageId }), 'unknown_page');
  }, 30_000);

  it('survives a Chrome restart via connect()', async () => {
    const dedicated = await startTestChrome();
    const adapter = createBrowserAdapter({
      endpoint: dedicated.endpoint,
      maxTabs: 10,
      visibleModeRequired: false,
    });
    try {
      await adapter.connect();
      await adapter.openPage();
      expect(adapter.isConnected()).toBe(true);

      await dedicated.close();
      await vi.waitFor(
        () => {
          expect(adapter.isConnected()).toBe(false);
        },
        { timeout: 10_000 },
      );
      await expectCode(() => adapter.listPages(), 'not_connected');

      // Chrome comes back on the same port (a fresh process and profile).
      let restarted: TestChrome | undefined;
      for (let attempt = 0; attempt < 3 && !restarted; attempt += 1) {
        try {
          restarted = await startTestChrome({ port: dedicated.port });
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      expect(restarted).toBeDefined();
      if (!restarted) return;

      await adapter.connect();
      expect(adapter.isConnected()).toBe(true);
      const pages = await adapter.listPages();
      expect(pages.length).toBeGreaterThan(0);
      await restarted.close();
    } finally {
      await adapter.dispose();
    }
  }, 90_000);

  it('connects through the Stage 3 gateway with an Authorization header', async () => {
    const gateway: CdpGatewayHandle = await createCdpGateway({
      listenHost: '127.0.0.1',
      listenPort: 0,
      target: chrome.endpoint,
      bearerToken: GATEWAY_TOKEN,
      allowedCidrs: ['127.0.0.1/32'],
    });
    const info = await gateway.listen();
    try {
      const adapter = createBrowserAdapter({
        endpoint: `http://127.0.0.1:${info.port}`,
        headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` },
        maxTabs: 100,
        visibleModeRequired: false,
      });
      adapters.push(adapter);
      await adapter.connect();
      const pageId = await (async () => {
        const page = await adapter.openPage({ url: `${fixture.url}/form` });
        return page.pageId;
      })();
      const snapshot = await adapter.snapshot({ pageId });
      expect(snapshot).toContain('Form');
      expect(snapshot).not.toContain('hunter2secret');

      const wrong = createBrowserAdapter({
        endpoint: `http://127.0.0.1:${info.port}`,
        headers: { Authorization: 'Bearer wrong-token' },
      });
      adapters.push(wrong);
      await expectCode(() => wrong.connect(), 'connect_failed');
    } finally {
      await gateway.close();
    }
  }, 60_000);

  it('connects via a ws:// endpoint directly', async () => {
    const version = await cdpGet(chrome.port, '/json/version');
    const { webSocketDebuggerUrl } = JSON.parse(version.body) as { webSocketDebuggerUrl: string };
    expect(webSocketDebuggerUrl).toContain('/devtools/browser/');

    const adapter = createBrowserAdapter({
      endpoint: webSocketDebuggerUrl,
      maxTabs: 100,
      visibleModeRequired: false,
    });
    adapters.push(adapter);
    await adapter.connect();
    expect(adapter.isConnected()).toBe(true);
    const pages = await adapter.listPages();
    expect(pages.length).toBeGreaterThan(0);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Stage 6: visible-mode enforcement + human-control adapter operations
  // -------------------------------------------------------------------------

  it('refuses a headless Chrome when visible mode is required', async () => {
    // The disposable test Chrome is headless by default, so with the Stage 6
    // default (visibleModeRequired=true) the connect must be refused BEFORE
    // any Playwright attach: the user must be able to see the tab to take over.
    const adapter = createBrowserAdapter({
      endpoint: chrome.endpoint,
      visibleModeRequired: true,
    });
    adapters.push(adapter);
    const error = await expectCode(() => adapter.connect(), 'endpoint_forbidden');
    expect(error.message.toLowerCase()).toContain('headless');
    expect(adapter.isConnected()).toBe(false);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Stage 6 human-control adapter operations run against their OWN fresh Chrome.
// After ~22 connectOverCDP cycles in the suite above, the long-lived shared
// browser/process degrades and late connects/operations stall past the test
// budget — these three cases complete in well under a second on a fresh
// browser (verified in isolation). A dedicated browser keeps them
// deterministic without weakening any assertion.
// ---------------------------------------------------------------------------
describe.skipIf(!chromePath)('BrowserAdapter Stage 6 human-control operations', () => {
  let chrome: TestChrome;
  let fixture: Fixture;
  const adapters: BrowserAdapter[] = [];

  beforeAll(async () => {
    chrome = await startTestChrome();
    fixture = await startFixtureServer();
  }, 60_000);

  afterAll(async () => {
    while (adapters.length > 0) {
      const adapter = adapters.pop() as BrowserAdapter;
      await adapter.dispose().catch(() => undefined);
    }
    if (fixture) await fixture.close();
    if (chrome) await chrome.close();
  }, 60_000);

  async function newAdapter(
    overrides: Partial<BrowserAdapterOptions> = {},
  ): Promise<BrowserAdapter> {
    const adapter = createBrowserAdapter({
      endpoint: chrome.endpoint,
      maxTabs: 100,
      visibleModeRequired: false,
      ...overrides,
    });
    adapters.push(adapter);
    await adapter.connect();
    return adapter;
  }

  it('challengeScan returns url, frame URLs and capped visible text', async () => {
    const adapter = await newAdapter();
    const page = await adapter.openPage({ url: `${fixture.url}/challenge` });
    const scan = await adapter.challengeScan({ pageId: page.pageId });
    expect(scan.url).toBe(`${fixture.url}/challenge`);
    expect(scan.title).toBe('Security check');
    // The embedded provider iframe must be visible to the detector.
    expect(scan.frameUrls.some((frameUrl) => frameUrl.includes('recaptcha'))).toBe(true);
    expect(scan.visibleText).toContain('verify you are human');
    // Scan text is capped (fixture text is short; assert the cap applies).
    expect(scan.visibleText.length).toBeLessThanOrEqual(8_000);
  }, 30_000);

  it('describeLocator returns the accessible name of the target', async () => {
    const adapter = await newAdapter();
    const page = await adapter.openPage({ url: `${fixture.url}/form` });
    const byText = await adapter.describeLocator({
      pageId: page.pageId,
      locator: { kind: 'css', selector: '#go' },
    });
    expect(byText.name).toBe('Submit');
    const byAria = await adapter.describeLocator({
      pageId: page.pageId,
      locator: { kind: 'css', selector: '#aria-buy' },
    });
    expect(byAria.name).toBe('Buy now');
  }, 30_000);

  it('bringToFront activates a tab without error', async () => {
    const adapter = await newAdapter();
    const page = await adapter.openPage({ url: `${fixture.url}/form` });
    await expect(adapter.bringToFront({ pageId: page.pageId })).resolves.toBeUndefined();
  }, 30_000);
});

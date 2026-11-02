/**
 * The spec runner: HTTP transport against a local fixture server (synthetic
 * content — no real site internals anywhere in this repository), the `check`
 * contract, error mapping, and the browser transport against a fake adapter.
 */
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BrowserAdapter } from '../../src/browser/adapter.js';
import type { DomainPolicy } from '../../src/policy/domains.js';
import { runSpecCheck, runSpecOp } from '../../src/spec/run.js';
import { SpecError } from '../../src/spec/store.js';
import type { SiteSpec } from '../../src/spec/types.js';

const CARDS = [
  '<article class="card"><h3>Alpha</h3><span class="p">11,00 €</span></article>',
  '<article class="card"><h3>Beta</h3><span class="p">22,00 €</span></article>',
  // Third card uses a markup variant the pattern does not cover (the pitfall
  // the `check` contract exists for).
  '<article class="card"><h3>Gamma</h3><span class="oos">unavailable</span></article>',
].join('\n');

let server: Server;
let base = '';
let spec: SiteSpec;
let flakyHits = 0;

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
    const send = (status: number, body: string, type = 'text/html; charset=utf-8'): void => {
      response.writeHead(status, { 'content-type': type });
      response.end(body);
    };
    if (path === '/listing') return send(200, CARDS);
    if (path === '/api') {
      return send(200, JSON.stringify({ data: { items: [{ id: 1, name: 'One' }, { id: 2, name: 'Two' }] } }), 'application/json');
    }
    if (path === '/notjson') return send(200, '<html>not json</html>');
    if (path === '/flaky') {
      flakyHits += 1;
      if (flakyHits === 1) return send(500, 'anti-bot burst');
      return send(200, JSON.stringify({ data: [{ id: flakyHits }] }), 'application/json');
    }
    if (path === '/empty') return send(200, '<html><body>nothing here</body></html>');
    return send(404, 'nope');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });

  spec = {
    name: 'fixture',
    displayName: 'Synthetic fixture (tests only)',
    baseUrl: base,
    ops: {
      listing: {
        description: 'Cards with a title and a price',
        transport: 'http',
        url: `${base}/listing`,
        response: {
          format: 'html',
          item_pattern: '<article class="card">(?s:.*?)</article>',
          pick: [
            { name: 'title', pattern: '<h3>([^<]+)</h3>' },
            { name: 'price', pattern: '<span class="p">([^<]+)</span>' },
          ],
        },
        check: { expect: ['title', 'price'] },
      },
      api: {
        transport: 'http',
        url: `${base}/api`,
        response: { format: 'json', extract: 'data.items', pick: ['id', 'name'], multi: true },
      },
      flaky: {
        transport: 'http',
        url: `${base}/flaky`,
        timeout: 5,
        retries: 1,
        retry_wait: 0.01,
        response: { format: 'json', extract: 'data', pick: ['id'] },
      },
      gone: { transport: 'http', url: `${base}/missing`, response: { format: 'json', extract: 'data' } },
      notjson: { transport: 'http', url: `${base}/notjson`, response: { format: 'json' } },
      empty: {
        transport: 'http',
        url: `${base}/empty`,
        response: { format: 'html', pick: [{ name: 'title', pattern: '<h3>([^<]+)</h3>' }] },
        check: { expect: ['title'] },
      },
    },
  };
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
});

describe('http transport', () => {
  it('extracts one row per item from an SSR page', async () => {
    const result = await runSpecOp(spec, 'listing', {}, {});
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.data).toEqual([
      { title: 'Alpha', price: '11,00 €' },
      { title: 'Beta', price: '22,00 €' },
      { title: 'Gamma', price: null },
    ]);
  });

  it('extracts rows from a JSON response', async () => {
    const result = await runSpecOp(spec, 'api', {}, {});
    expect(result.data).toEqual([
      { id: 1, name: 'One' },
      { id: 2, name: 'Two' },
    ]);
  });

  it('reports an HTTP error with its status, never a silent empty result', async () => {
    const result = await runSpecOp(spec, 'gone', {}, {});
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.error).toMatch(/^HTTP 404 \(body \d+ chars\)$/);
  });

  it('retries a 5xx burst once, like the skill did for anti-bot 500s', async () => {
    flakyHits = 0;
    const result = await runSpecOp(spec, 'flaky', {}, {});
    expect(result.ok).toBe(true);
    expect(flakyHits).toBe(2);
  });

  it('reports an extraction failure as such (site changed?)', async () => {
    const result = await runSpecOp(spec, 'notjson', {}, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^extract failed: /);
  });

  it('reports no data at the pick path instead of empty strings', async () => {
    const result = await runSpecOp(spec, 'empty', {}, {});
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ title: null });
    // …and the check is what turns that into a failure.
    const check = await runSpecCheck(spec, 'empty', {}, {});
    expect(check.ok).toBe(false);
    expect(check.check.missing).toEqual(['0:title']);
  });
});

describe('check contract', () => {
  it('passes when every expected field is present in every row', async () => {
    const outcome = await runSpecCheck(spec, 'api', {}, {});
    // `api` has no check block: nothing expected means nothing enforced.
    expect(outcome.ok).toBe(true);
    expect(outcome.check.rows).toBe(2);
  });

  it('fails on a mid-list hole and names the row and field', async () => {
    const outcome = await runSpecCheck(spec, 'listing', {}, {});
    expect(outcome.ok).toBe(false);
    expect(outcome.check).toEqual({ missing: ['2:price'], rows: 3 });
  });

  it('rejects an unknown op with a typed spec error', async () => {
    await expect(runSpecOp(spec, 'nope', {}, {})).rejects.toBeInstanceOf(SpecError);
    await expect(runSpecOp(spec, 'nope', {}, {})).rejects.toMatchObject({ code: 'spec_unknown_op' });
  });
});

describe('domain policy', () => {
  it('refuses a host outside the allowlist instead of fetching it', async () => {
    const domainPolicy = {
      assertNavigableUrl: (url: string) => {
        if (new URL(url).hostname === 'blocked.test') {
          throw new Error('domain_forbidden: blocked.test is not on the allowlist');
        }
      },
    } as unknown as DomainPolicy;
    const blockedSpec: SiteSpec = {
      name: 'blocked',
      ops: { x: { transport: 'http', url: 'https://blocked.test/api', response: { format: 'json' } } },
    };
    await expect(runSpecOp(blockedSpec, 'x', {}, { domainPolicy })).rejects.toThrow(/domain_forbidden/);
  });
});

describe('browser-mcp transport', () => {
  const CARD_BLOBS = ['Widget 10,00 €', 'Gadget 20,00 €'];
  const browserSpec: SiteSpec = {
    name: 'fixture-browser',
    ops: {
      search: {
        transport: 'browser-mcp',
        url: 'https://pro.example.test/produits/?phrase={sku}',
        tab_match: '/produits',
        wait_selector: '.card',
        item_selector: '.card',
        settle: 0,
        response: {
          format: 'browser-text',
          item_pattern: 'per-card',
          pick: [
            { name: 'title', pattern: '^([A-Za-z]+)' },
            { name: 'price', pattern: '(\\d+,\\d{2}) €' },
          ],
        },
      },
    },
  };

  function fakeAdapter(overrides: Record<string, unknown> = {}): BrowserAdapter {
    return {
      isConnected: () => true,
      listPages: vi.fn(async () => [
        { pageId: 'page-1', contextId: 'ctx-1', url: 'chrome://new-tab-page/', title: '', openedByAdapter: false },
        { pageId: 'page-2', contextId: 'ctx-1', url: 'https://pro.example.test/produits/', title: 'PRO', openedByAdapter: true },
      ]),
      navigate: vi.fn(async (params: { pageId: string; url: string }) => ({
        pageId: params.pageId,
        contextId: 'ctx-1',
        url: params.url,
        title: 'PRO',
        openedByAdapter: true,
      })),
      openPage: vi.fn(async (params: { url?: string }) => ({
        pageId: 'page-3',
        contextId: 'ctx-1',
        url: params.url ?? 'about:blank',
        title: 'PRO',
        openedByAdapter: true,
      })),
      wait: vi.fn(async () => undefined),
      extract: vi.fn(async () => ({ url: 'https://pro.example.test/produits/', title: 'PRO', items: CARD_BLOBS, truncated: false })),
      ...overrides,
    } as unknown as BrowserAdapter;
  }

  it('reuses the workflow tab instead of opening a new one', async () => {
    const adapter = fakeAdapter();
    const result = await runSpecOp(browserSpec, 'search', { sku: '1075-80' }, { adapter });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.data).toEqual([
      { title: 'Widget', price: '10,00' },
      { title: 'Gadget', price: '20,00' },
    ]);
    expect(adapter.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: 'page-2', url: 'https://pro.example.test/produits/?phrase=1075-80' }),
    );
    expect(adapter.openPage).not.toHaveBeenCalled();
    // The user's own tab is never touched.
    expect(adapter.extract).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: 'page-2', locator: { kind: 'css', selector: '.card' } }),
    );
  });

  it('opens a new tab when no tab matches the spec marker', async () => {
    const adapter = fakeAdapter({
      listPages: vi.fn(async () => [
        { pageId: 'page-9', contextId: 'ctx-1', url: 'https://elsewhere.test/', title: '', openedByAdapter: false },
      ]),
    });
    const result = await runSpecOp(browserSpec, 'search', { sku: 'x' }, { adapter });
    expect(result.ok).toBe(true);
    expect(adapter.openPage).toHaveBeenCalledTimes(1);
    expect(adapter.navigate).not.toHaveBeenCalled();
  });

  it('treats a wait timeout as a normal empty result page', async () => {
    const adapter = fakeAdapter({
      wait: vi.fn(async () => {
        throw new Error('timeout waiting for .card');
      }),
      extract: vi.fn(async () => ({ url: 'u', title: 't', items: [], truncated: false })),
    });
    const result = await runSpecOp(browserSpec, 'search', { sku: 'x' }, { adapter });
    // An empty result page is a valid answer (the op's `check` block is what
    // judges it), never a transport failure — same rule the Python caller had.
    expect(result.ok).toBe(true);
    expect(result.data).toEqual([]);
    expect(result.status).toBe(200);
  });

  it('demands a connected Chrome with the same typed error the page tools use', async () => {
    const adapter = fakeAdapter({ isConnected: () => false });
    await expect(runSpecOp(browserSpec, 'search', { sku: 'x' }, { adapter })).rejects.toMatchObject({
      code: 'not_connected',
    });
  });

  it('reports a browser failure without pretending it was an HTTP problem', async () => {
    const adapter = fakeAdapter({
      navigate: vi.fn(async () => {
        throw new Error('target closed');
      }),
    });
    const result = await runSpecOp(browserSpec, 'search', { sku: 'x' }, { adapter });
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toBe('browser-mcp failed: target closed');
  });
});

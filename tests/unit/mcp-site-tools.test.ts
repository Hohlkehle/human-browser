/**
 * site_list / site_op / site_check through a real MCP client/server pair.
 *
 * The specs used here are synthetic (built in the test and served by a local
 * fixture server) — the repository never carries a learned spec, and no real
 * site internals appear anywhere in it.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BrowserAdapter } from '../../src/browser/adapter.js';
import { createHumanGate, type HumanGate } from '../../src/human/gate.js';
import { createBrowserMcpServer } from '../../src/mcp/server.js';
import { createDomainPolicy } from '../../src/policy/domains.js';
import { createSpecStore } from '../../src/spec/index.js';

const logger = pino({ level: 'silent' });

function structured(result: CallToolResult): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

function errorOf(result: CallToolResult): { code: string; message: string; retryable: boolean } {
  return structured(result).error as { code: string; message: string; retryable: boolean };
}

function card(index: number): string {
  // Every third card hides its price behind a markup variant the spec's
  // pattern does not cover — the situation `check` exists to catch.
  const price =
    index % 3 === 2 ? '<span class="oos">unavailable</span>' : `<span class="p">${index},00 €</span>`;
  return `<article class="card"><h3>Item ${index}</h3>${price}</article>`;
}

const CARDS = Array.from({ length: 9 }, (_value, index) => card(index)).join('\n');

let server: Server;
let base = '';
let specsDir = '';
let missingDir = '';

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
    if (pathname === '/listing') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(CARDS);
      return;
    }
    if (pathname === '/api') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: { items: [{ id: 1, name: 'One' }] } }));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('nope');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });

  specsDir = await mkdtemp(path.join(tmpdir(), 'hb-specs-'));
  missingDir = path.join(specsDir, 'does-not-exist');
  await writeFile(
    path.join(specsDir, 'fixture.json'),
    JSON.stringify({
      name: 'fixture',
      displayName: 'Synthetic fixture',
      baseUrl: base,
      description: 'Tests only',
      learned_at: '2026-11-03T00:00:00Z',
      ops: {
        listing: {
          description: 'Cards with a title and a price',
          transport: 'http',
          url: `${base}/listing`,
          params: [{ name: 'code', example: '9', hint: 'ignored by the fixture' }],
          response: {
            format: 'html',
            item_pattern: '<article class="card">(?s:.*?)</article>',
            pick: [
              { name: 'title', pattern: '<h3>([^<]+)</h3>' },
              { name: 'price', pattern: '<span class="p">([^<]+)</span>' },
            ],
          },
          check: { params: { code: '9' }, expect: ['title', 'price'] },
        },
        gone: { description: '404s', transport: 'http', url: `${base}/missing`, response: { format: 'json' } },
        api: {
          description: 'JSON',
          transport: 'http',
          url: `${base}/api`,
          response: { format: 'json', extract: 'data.items', pick: ['id', 'name'] },
        },
      },
    }),
  );
  await writeFile(path.join(specsDir, 'broken.json'), '{ not json');
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await rm(specsDir, { recursive: true, force: true });
});

interface Harness {
  client: Client;
  adapter: BrowserAdapter;
  humanGate: HumanGate;
  close(): Promise<void>;
}

function fakeAdapter(overrides: Record<string, unknown> = {}): BrowserAdapter {
  return {
    isConnected: vi.fn(() => true),
    listPages: vi.fn(async () => [
      { pageId: 'page-4', contextId: 'ctx-1', url: 'https://pro.example.test/produits/', title: 'PRO', openedByAdapter: true },
    ]),
    navigate: vi.fn(async (params: { pageId: string; url: string }) => ({
      pageId: params.pageId,
      contextId: 'ctx-1',
      url: params.url,
      title: 'PRO',
      openedByAdapter: true,
    })),
    openPage: vi.fn(async (params: { url?: string }) => ({
      pageId: 'page-5',
      contextId: 'ctx-1',
      url: params.url ?? 'about:blank',
      title: 'PRO',
      openedByAdapter: true,
    })),
    wait: vi.fn(async () => undefined),
    extract: vi.fn(async () => ({
      url: 'https://pro.example.test/produits/',
      title: 'PRO',
      items: ['Widget 10,00 €', 'Gadget — Temporairement indisponible'],
      truncated: false,
    })),
    ...overrides,
  } as unknown as BrowserAdapter;
}

async function setup(options: { adapter?: BrowserAdapter; specsDir?: string } = {}): Promise<Harness> {
  const adapter = options.adapter ?? fakeAdapter();
  const humanGate = createHumanGate();
  const handle = createBrowserMcpServer({
    adapter,
    domainPolicy: createDomainPolicy(['*']),
    humanGate,
    specStore: createSpecStore(options.specsDir ?? specsDir),
    version: '0.1.0',
    logger,
  });
  const mcpServer = handle.build();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: 'site-tools-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    adapter,
    humanGate,
    async close() {
      await client.close();
      await mcpServer.close();
    },
  };
}

describe('site_list', () => {
  it('lists the learned specs with their ops, params and check contract', async () => {
    const harness = await setup();
    try {
      const result = (await harness.client.callTool({ name: 'site_list', arguments: {} })) as CallToolResult;
      expect(result.isError).toBeFalsy();
      const out = structured(result);
      expect(out.dir).toBe(specsDir);
      const specs = out.specs as Array<Record<string, unknown>>;
      const fixture = specs.find((spec) => spec.name === 'fixture');
      expect(fixture).toBeTruthy();
      expect(fixture!.baseUrl).toBe(base);
      const ops = fixture!.ops as Array<Record<string, unknown>>;
      expect(ops.map((op) => op.name).sort()).toEqual(['api', 'gone', 'listing']);
      expect(ops.find((op) => op.name === 'listing')).toMatchObject({
        transport: 'http',
        hasCheck: true,
        params: [{ name: 'code', example: '9', hint: 'ignored by the fixture' }],
      });
      // A broken spec file is reported, not hidden.
      const broken = specs.find((spec) => spec.name === 'broken');
      expect(String(broken?.description)).toMatch(/^INVALID: /);
      expect(result.content[0]).toMatchObject({ type: 'text' });
      expect(String((result.content[0] as { text: string }).text)).toContain('1 invalid file(s)');
    } finally {
      await harness.close();
    }
  });

  it('reports an unknown spec name as a typed error', async () => {
    const harness = await setup();
    try {
      const result = (await harness.client.callTool({
        name: 'site_list',
        arguments: { site: 'nope' },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(errorOf(result).code).toBe('spec_not_found');
    } finally {
      await harness.close();
    }
  });

  it('says where to point SITE_SPECS_DIR when the directory is missing', async () => {
    const harness = await setup({ specsDir: missingDir });
    try {
      const result = (await harness.client.callTool({ name: 'site_list', arguments: {} })) as CallToolResult;
      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.code).toBe('specs_dir_missing');
      expect(error.message).toContain('SITE_SPECS_DIR');
      expect(error.retryable).toBe(false);
    } finally {
      await harness.close();
    }
  });
});

describe('site_op', () => {
  it('replays an HTTP op and reports the total row count', async () => {
    const harness = await setup();
    try {
      const result = (await harness.client.callTool({
        name: 'site_op',
        arguments: { site: 'fixture', op: 'listing', params: { code: '9' } },
      })) as CallToolResult;
      expect(result.isError).toBeFalsy();
      const out = structured(result);
      expect(out).toMatchObject({ site: 'fixture', op: 'listing', transport: 'http', ok: true, rows: 9 });
      expect(out.truncated).toBe(false);
      expect(out.opError).toBeNull();
      expect((out.data as unknown[])[0]).toEqual({ title: 'Item 0', price: '0,00 €' });
      // An empty price stays null — never 0 and never dropped.
      expect((out.data as unknown[])[2]).toEqual({ title: 'Item 2', price: null });
    } finally {
      await harness.close();
    }
  });

  it('caps data at limit while still reporting every row', async () => {
    const harness = await setup();
    try {
      const result = (await harness.client.callTool({
        name: 'site_op',
        arguments: { site: 'fixture', op: 'listing', limit: 2 },
      })) as CallToolResult;
      const out = structured(result);
      expect(out.rows).toBe(9);
      expect(out.truncated).toBe(true);
      expect(out.data).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  it('returns a site_no_data error instead of pretending the site is fine', async () => {
    const harness = await setup();
    try {
      const result = (await harness.client.callTool({
        name: 'site_op',
        arguments: { site: 'fixture', op: 'gone' },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      const out = structured(result);
      expect(out.ok).toBe(false);
      expect(out.opError).toMatch(/^HTTP 404 \(body \d+ chars\)$/);
      expect(errorOf(result)).toMatchObject({ code: 'site_no_data', retryable: false });
    } finally {
      await harness.close();
    }
  });

  it('rejects an unknown op with the available names', async () => {
    const harness = await setup();
    try {
      const result = (await harness.client.callTool({
        name: 'site_op',
        arguments: { site: 'fixture', op: 'nope' },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.code).toBe('spec_unknown_op');
      expect(error.message).toContain('listing');
    } finally {
      await harness.close();
    }
  });

  it('drives the browser transport through this same server (merged capability)', async () => {
    const adapter = fakeAdapter();
    const harness = await setup({ adapter });
    try {
      await writeFile(
        path.join(specsDir, 'fixture-browser.json'),
        JSON.stringify({
          name: 'fixture-browser',
          ops: {
            search: {
              description: 'Card blob list',
              transport: 'browser-mcp',
              url: 'https://pro.example.test/produits/?phrase={sku}',
              tab_match: '/produits',
              item_selector: '.card',
              settle: 0,
              response: {
                format: 'browser-text',
                item_pattern: 'per-card',
                pick: [
                  { name: 'title', pattern: '^([A-Za-z]+)' },
                  { name: 'availability', pattern: '(10,00 €|Temporairement indisponible)' },
                ],
              },
            },
          },
        }),
      );
      const result = (await harness.client.callTool({
        name: 'site_op',
        arguments: { site: 'fixture-browser', op: 'search', params: { sku: '7.02256.37.0' } },
      })) as CallToolResult;
      expect(result.isError).toBeFalsy();
      const out = structured(result);
      expect(out).toMatchObject({ transport: 'browser-mcp', ok: true, rows: 2 });
      expect(out.data).toEqual([
        { title: 'Widget', availability: '10,00 €' },
        { title: 'Gadget', availability: 'Temporairement indisponible' },
      ]);
      expect(adapter.navigate).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://pro.example.test/produits/?phrase=7.02256.37.0' }),
      );
    } finally {
      await harness.close();
    }
  });

  it('reports a sign-in redirect instead of a silent zero-row success', async () => {
    // The found-in-the-wild case: the site answers 200 on the login page, so
    // without this check a spending op would look like "the site has 0 results".
    const adapter = fakeAdapter({
      listPages: vi.fn(async () => [
        {
          pageId: 'page-5',
          contextId: 'ctx-1',
          url: 'https://pro.example.test/account/login/?next=/produits/',
          title: 'Sign in',
          openedByAdapter: true,
        },
      ]),
    });
    const harness = await setup({ adapter });
    try {
      await writeFile(
        path.join(specsDir, 'fixture-browser.json'),
        JSON.stringify({
          name: 'fixture-browser',
          ops: {
            search: {
              description: 'Card blob list',
              transport: 'browser-mcp',
              url: 'https://pro.example.test/produits/?phrase={sku}',
              tab_match: '/produits',
              item_selector: '.card',
              settle: 0,
              response: { format: 'browser-text', item_pattern: 'per-card' },
            },
          },
        }),
      );
      const result = (await harness.client.callTool({
        name: 'site_op',
        arguments: { site: 'fixture-browser', op: 'search', params: { sku: '1' } },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      const out = structured(result);
      expect(out.ok).toBe(false);
      expect(out.rows).toBe(0);
      expect(String(out.opError)).toContain('/account/login/');
      expect(String(out.opError)).toContain('not signed in for pro.example.test');
      expect(String(out.opError)).toContain('Sign in there');
      expect(errorOf(result).code).toBe('site_no_data');
    } finally {
      await harness.close();
    }
  });

  it('is refused while the user is handling a CAPTCHA or login', async () => {
    const harness = await setup();
    try {
      harness.humanGate.pause({ reason: 'login', pageId: 'page-1', kind: 'manual' });
      const result = (await harness.client.callTool({
        name: 'site_op',
        arguments: { site: 'fixture', op: 'listing' },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(errorOf(result).code).toBe('human_required');
    } finally {
      await harness.close();
    }
  });

  it('is advertised as read-only and not destructive', async () => {
    const harness = await setup();
    try {
      const { tools } = await harness.client.listTools();
      for (const name of ['site_list', 'site_op', 'site_check']) {
        const tool = tools.find((entry) => entry.name === name);
        expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
        expect(JSON.stringify(tool?.inputSchema)).toContain('site');
      }
    } finally {
      await harness.close();
    }
  });
});

describe('site_check', () => {
  it('fails with rowIndex:field when a row no longer matches', async () => {
    const harness = await setup();
    try {
      const result = (await harness.client.callTool({
        name: 'site_check',
        arguments: { site: 'fixture', op: 'listing' },
      })) as CallToolResult;
      // A failing check is an answer, not a tool error.
      expect(result.isError).toBeFalsy();
      const out = structured(result);
      expect(out.ok).toBe(false);
      expect(out.rows).toBe(9);
      expect(out.missing).toEqual(['2:price', '5:price', '8:price']);
      expect(out.expect).toEqual(['title', 'price']);
      expect(String((result.content[0] as { text: string }).text)).toContain('FAILED');
    } finally {
      await harness.close();
    }
  });

  it('passes on a spec whose rows are all complete', async () => {
    const harness = await setup();
    try {
      await writeFile(
        path.join(specsDir, 'clean.json'),
        JSON.stringify({
          name: 'clean',
          ops: {
            api: {
              transport: 'http',
              url: `${base}/api`,
              response: { format: 'json', extract: 'data.items', pick: ['id', 'name'] },
              check: { expect: ['id', 'name'] },
            },
          },
        }),
      );
      const result = (await harness.client.callTool({
        name: 'site_check',
        arguments: { site: 'clean', op: 'api' },
      })) as CallToolResult;
      const out = structured(result);
      expect(out.ok).toBe(true);
      expect(out.missing).toEqual([]);
      expect(out.rows).toBe(1);
    } finally {
      await harness.close();
    }
  });

  it('surfaces an op failure together with the check result', async () => {
    const harness = await setup();
    try {
      const result = (await harness.client.callTool({
        name: 'site_check',
        arguments: { site: 'fixture', op: 'gone' },
      })) as CallToolResult;
      const out = structured(result);
      expect(out.ok).toBe(false);
      expect(out.rows).toBe(0);
      expect(out.missing).toEqual(['<no rows extracted>']);
      expect(String(out.opError)).toMatch(/^HTTP 404/);
    } finally {
      await harness.close();
    }
  });
});

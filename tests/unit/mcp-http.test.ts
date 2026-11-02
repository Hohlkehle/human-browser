/**
 * Stage 5 unit tests: MCP Streamable HTTP transport (no Chrome — scripted
 * fake adapter). Covers loopback/wildcard binding rules, health endpoints,
 * body limits, and a real MCP client session over HTTP.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserAdapter } from '../../src/browser/adapter.js';
import { createHumanGate } from '../../src/human/gate.js';
import { createMcpHttpServer, type McpHttpServerHandle } from '../../src/mcp/http.js';
import { createBrowserMcpServer, type BrowserMcpServerHandle } from '../../src/mcp/server.js';
import { createDomainPolicy } from '../../src/policy/domains.js';

function createFakeAdapter(): BrowserAdapter {
  const status = {
    connected: false,
    endpoint: 'http://127.0.0.1:9222',
    tabs: 0,
    contexts: 0,
    runningOperations: 0,
    queuedOperations: 0,
    limits: {
      maxTabs: 8,
      maxConcurrentOperations: 4,
      maxQueuedOperations: 16,
      operationTimeoutMs: 30_000,
    },
  };
  return {
    connect: vi.fn(async () => status),
    disconnect: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    isConnected: vi.fn(() => false),
    status: vi.fn(() => status),
    listPages: vi.fn(async () => []),
    openPage: vi.fn(async () => ({
      pageId: 'page-1',
      contextId: 'ctx-1',
      url: 'about:blank',
      title: '',
    })),
    closePage: vi.fn(async (params) => ({
      pageId: params.pageId,
      closed: true as const,
      remainingTabs: 1,
      url: 'about:blank',
    })),
    navigate: vi.fn(async () => ({
      pageId: 'page-1',
      contextId: 'ctx-1',
      url: 'about:blank',
      title: '',
    })),
    snapshot: vi.fn(async () => ''),
    screenshot: vi.fn(async () => Buffer.alloc(0)),
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    selectOption: vi.fn(async () => []),
    press: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
    extract: vi.fn(async () => ({ url: '', title: '', items: [], truncated: false })),
    challengeScan: vi.fn(async () => ({ url: '', title: '', frameUrls: [], visibleText: '' })),
    bringToFront: vi.fn(async () => {}),
    describeLocator: vi.fn(async () => ({ name: '' })),
  };
}

const cleanups: Array<() => Promise<void>> = [];

async function startServer(options: { maxBodyBytes?: number } = {}): Promise<McpHttpServerHandle> {
  const handle: BrowserMcpServerHandle = createBrowserMcpServer({
    adapter: createFakeAdapter(),
    domainPolicy: createDomainPolicy(['allowed.test']),
    humanGate: createHumanGate(),
    version: '0.1.0',
    logger: pino({ level: 'silent' }),
  });
  const http = await createMcpHttpServer({
    buildMcpServer: () => handle.build(),
    listenHost: '127.0.0.1',
    listenPort: 0,
    logger: pino({ level: 'silent' }),
    ...(options.maxBodyBytes !== undefined ? { maxBodyBytes: options.maxBodyBytes } : {}),
  });
  cleanups.push(async () => {
    await http.close();
  });
  return http;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

async function fetchText(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: string }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.text() };
}

describe('createMcpHttpServer', () => {
  it('refuses specific non-loopback bind addresses', async () => {
    const handle = createBrowserMcpServer({
      adapter: createFakeAdapter(),
      domainPolicy: createDomainPolicy(['allowed.test']),
      humanGate: createHumanGate(),
      version: '0.1.0',
      logger: pino({ level: 'silent' }),
    });
    for (const host of ['10.0.0.5', '192.168.1.10']) {
      await expect(
        createMcpHttpServer({
          buildMcpServer: () => handle.build(),
          listenHost: host,
          listenPort: 0,
        }),
      ).rejects.toThrow(/loopback/);
    }
  });

  it('accepts the wildcard bind and answers health endpoints through loopback', async () => {
    const handle = createBrowserMcpServer({
      adapter: createFakeAdapter(),
      domainPolicy: createDomainPolicy(['allowed.test']),
      humanGate: createHumanGate(),
      version: '0.1.0',
      logger: pino({ level: 'silent' }),
    });
    const http = await createMcpHttpServer({
      buildMcpServer: () => handle.build(),
      listenHost: '0.0.0.0',
      listenPort: 0,
      logger: pino({ level: 'silent' }),
    });
    cleanups.push(async () => {
      await http.close();
    });
    expect(http.host).toBe('0.0.0.0');
    const response = await fetch(`http://127.0.0.1:${http.port}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(JSON.stringify({ status: 'ok' }));
  });

  it('answers health endpoints locally and 404 elsewhere', async () => {
    const http = await startServer();
    const base = `http://127.0.0.1:${http.port}`;
    expect((await fetchText(`${base}/healthz`)).status).toBe(200);
    expect((await fetchText(`${base}/readyz`)).status).toBe(200);
    expect((await fetchText(`${base}/healthz`)).body).toBe(JSON.stringify({ status: 'ok' }));
    expect((await fetchText(`${base}/anything-else`)).status).toBe(404);
  });

  it('rejects invalid JSON and oversized bodies on /mcp', async () => {
    const http = await startServer({ maxBodyBytes: 1024 });
    const base = `http://127.0.0.1:${http.port}`;

    const invalid = await fetchText(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'this is not json',
    });
    expect(invalid.status).toBe(400);

    const tooLarge = await fetchText(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ junk: 'x'.repeat(4096) }),
    });
    expect(tooLarge.status).toBe(413);
  });

  it('answers DELETE /mcp with 405 in stateless mode', async () => {
    const http = await startServer();
    const response = await fetch(`http://127.0.0.1:${http.port}/mcp`, { method: 'DELETE' });
    expect(response.status).toBe(405);
    await response.body?.cancel();
  });

  it('serves a full MCP session over Streamable HTTP', async () => {
    const http = await startServer();
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${http.port}/mcp`),
    );
    const client = new Client({ name: 'http-unit-client', version: '0.0.0' });
    // The SDK's client transport types do not satisfy our
    // `exactOptionalPropertyTypes` view of the Transport interface; the
    // runtime contract is identical.
    await client.connect(transport as unknown as Transport);
    try {
      expect(client.getInstructions()).toContain('Security rules');
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(19);

      const result = (await client.callTool({
        name: 'browser_status',
        arguments: {},
      })) as CallToolResult;
      expect(result.isError).toBeFalsy();
      const status = (result.structuredContent ?? {}) as Record<string, unknown>;
      expect(status.connected).toBe(false);
      expect(status.humanControl).toEqual({ state: 'ready' });
    } finally {
      await client.close();
    }
  });
});

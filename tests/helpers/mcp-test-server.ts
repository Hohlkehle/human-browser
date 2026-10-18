/**
 * Shared helper for the Stage 7 tunnel tests: a loopback MCP Streamable HTTP
 * server backed by a scripted fake adapter (no Chrome needed). It answers
 * /healthz, /readyz, tools/list and browser_status exactly like the real
 * server, so doctor and test-connection checks can run in CI.
 */
import pino from 'pino';
import { vi } from 'vitest';
import type { BrowserAdapter } from '../../src/browser/adapter.js';
import { createHumanGate } from '../../src/human/gate.js';
import { createMcpHttpServer, type McpHttpServerHandle } from '../../src/mcp/http.js';
import { createBrowserMcpServer } from '../../src/mcp/server.js';
import { createDomainPolicy } from '../../src/policy/domains.js';

export function createFakeAdapter(): BrowserAdapter {
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

export async function startFakeMcpServer(): Promise<McpHttpServerHandle> {
  const handle = createBrowserMcpServer({
    adapter: createFakeAdapter(),
    domainPolicy: createDomainPolicy(['allowed.test']),
    humanGate: createHumanGate(),
    version: '0.1.0',
    logger: pino({ level: 'silent' }),
  });
  return await createMcpHttpServer({
    buildMcpServer: () => handle.build(),
    listenHost: '127.0.0.1',
    listenPort: 0,
    logger: pino({ level: 'silent' }),
  });
}

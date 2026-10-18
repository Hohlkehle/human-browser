import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { createCdpGateway, type CdpGatewayHandle } from '../../src/cdp/gateway.js';
import {
  FAKE_BROWSER_ID,
  FAKE_PAGE_ID,
  startFakeCdpUpstream,
  type FakeCdpUpstream,
} from '../helpers/fake-cdp-upstream.js';
import { connectWs, type WsConnection } from '../helpers/ws.js';

const TOKEN = 'integration-test-token-1234567890';

interface HttpResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

function httpRequest(options: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: options.port,
        path: options.path,
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

function nextMessage(ws: WsConnection): Promise<string> {
  return new Promise((resolve) => ws.once('message', resolve));
}

function nextClose(ws: WsConnection): Promise<void> {
  return new Promise((resolve) => ws.once('close', () => resolve()));
}

async function findDeadPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

let upstream: FakeCdpUpstream;
const gateways: CdpGatewayHandle[] = [];

async function startGateway(
  overrides: Partial<Parameters<typeof createCdpGateway>[0]> = {},
): Promise<{ gateway: CdpGatewayHandle; port: number }> {
  const gateway = await createCdpGateway({
    listenHost: '127.0.0.1',
    listenPort: 0,
    target: upstream.url,
    bearerToken: TOKEN,
    allowedCidrs: ['127.0.0.1/32'],
    ...overrides,
  });
  gateways.push(gateway);
  const info = await gateway.listen();
  return { gateway, port: info.port };
}

beforeAll(async () => {
  upstream = await startFakeCdpUpstream();
});

afterEach(async () => {
  while (gateways.length > 0) {
    await (gateways.pop() as CdpGatewayHandle).close();
  }
});

afterAll(async () => {
  await upstream.close();
});

describe('HTTP authentication', () => {
  it('returns 401 without a token', async () => {
    const { port } = await startGateway();
    const response = await httpRequest({ port, path: '/json/version' });
    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toMatch(/Bearer/);
  });

  it('returns 401 for a wrong or non-bearer token', async () => {
    const { port } = await startGateway();
    const wrong = await httpRequest({
      port,
      path: '/json/version',
      headers: { authorization: `Bearer ${TOKEN}-wrong` },
    });
    expect(wrong.status).toBe(401);

    const basic = await httpRequest({
      port,
      path: '/json/version',
      headers: { authorization: `Basic ${Buffer.from(TOKEN).toString('base64')}` },
    });
    expect(basic.status).toBe(401);
  });

  it('proxies /json/version with a valid token and rewrites the debugger URL', async () => {
    const { port } = await startGateway();
    const response = await httpRequest({
      port,
      path: '/json/version',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body['Protocol-Version']).toBe('1.3');
    // Rewritten to the gateway, never the upstream Chrome port.
    expect(body['webSocketDebuggerUrl']).toBe(
      `ws://127.0.0.1:${port}/devtools/browser/${FAKE_BROWSER_ID}`,
    );
    expect(response.body).not.toContain(`:${upstream.port}/`);
  });

  it('accepts the trailing-slash form Playwright uses (/json/version/)', async () => {
    const { port } = await startGateway();
    const response = await httpRequest({
      port,
      path: '/json/version/',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
  });

  it('proxies /json/list with a query string and rewrites debugger URLs', async () => {
    const { port } = await startGateway();
    const response = await httpRequest({
      port,
      path: '/json/list?for_tab',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const list = JSON.parse(response.body) as Array<Record<string, unknown>>;
    expect(list[0]?.['webSocketDebuggerUrl']).toBe(
      `ws://127.0.0.1:${port}/devtools/page/${FAKE_PAGE_ID}`,
    );
  });

  it('returns 404 for paths outside the allowlist even with a token', async () => {
    const { port } = await startGateway();
    for (const path of ['/json', '/json/protocol', '/', '/devtools']) {
      const response = await httpRequest({
        port,
        path,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status, path).toBe(404);
    }
  });
});

describe('health endpoints', () => {
  it('answers locally without auth and without Chrome data', async () => {
    const { port } = await startGateway();
    const healthz = await httpRequest({ port, path: '/healthz' });
    expect(healthz.status).toBe(200);
    expect(JSON.parse(healthz.body)).toEqual({ status: 'ok' });

    const readyz = await httpRequest({ port, path: '/readyz' });
    expect(readyz.status).toBe(200);
    expect(JSON.parse(readyz.body)).toEqual({ status: 'ready' });

    for (const body of [healthz.body, readyz.body]) {
      expect(body).not.toContain('Protocol-Version');
      expect(body).not.toContain('webSocketDebuggerUrl');
    }
    // Health is answered by the gateway itself, never proxied to Chrome.
    expect(upstream.httpHits.some((hit) => hit.pathname.startsWith('/healthz'))).toBe(false);
    expect(upstream.httpHits.some((hit) => hit.pathname.startsWith('/readyz'))).toBe(false);
  });
});

describe('CIDR allowlist', () => {
  it('returns 403 for an IP outside the allowlist (HTTP and WebSocket)', async () => {
    // Loopback client vs a non-loopback allowlist simulates an external IP.
    const { port } = await startGateway({ allowedCidrs: ['10.9.8.0/24'] });

    const health = await httpRequest({ port, path: '/healthz' });
    expect(health.status).toBe(403);

    const version = await httpRequest({
      port,
      path: '/json/version',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(version.status).toBe(403);

    await expect(
      connectWs(`ws://127.0.0.1:${port}/devtools/browser/x`, {
        authorization: `Bearer ${TOKEN}`,
      }),
    ).rejects.toThrow(/403/);
  });
});

describe('rate limiting', () => {
  it('returns 429 once the per-IP budget is exhausted', async () => {
    const { port } = await startGateway({ rateLimitMax: 3, rateLimitWindowMs: 60_000 });

    for (let i = 0; i < 3; i += 1) {
      expect((await httpRequest({ port, path: '/healthz' })).status).toBe(200);
    }
    const limited = await httpRequest({ port, path: '/healthz' });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('WebSocket', () => {
  it('rejects an unauthorized upgrade with 401', async () => {
    const { port } = await startGateway();
    await expect(connectWs(`ws://127.0.0.1:${port}/devtools/browser/x`)).rejects.toThrow(/401/);
    await expect(
      connectWs(`ws://127.0.0.1:${port}/devtools/browser/x`, {
        authorization: 'Bearer wrong-token',
      }),
    ).rejects.toThrow(/401/);
  });

  it('rejects upgrades outside /devtools/* with 404', async () => {
    const { port } = await startGateway();
    await expect(
      connectWs(`ws://127.0.0.1:${port}/json/version`, {
        authorization: `Bearer ${TOKEN}`,
      }),
    ).rejects.toThrow(/404/);
  });

  it('proxies an authenticated CDP session end to end', async () => {
    const { port } = await startGateway();
    const before = upstream.wsConnections();

    const ws = await connectWs(`ws://127.0.0.1:${port}/devtools/browser/${FAKE_BROWSER_ID}`, {
      authorization: `Bearer ${TOKEN}`,
    });
    const messagePromise = nextMessage(ws);
    ws.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
    const reply = JSON.parse(await messagePromise) as {
      id: number;
      result: { product: string };
    };
    expect(reply.id).toBe(1);
    expect(reply.result.product).toMatch(/^Chrome\/126\./);
    expect(upstream.wsConnections()).toBe(before + 1);

    const closed = nextClose(ws);
    ws.close();
    await closed;
  });
});

describe('Playwright', () => {
  it(
    'connectOverCDP works through the gateway with an Authorization header',
    async () => {
      const { port } = await startGateway();
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(browser.version()).toBe('126.0.6478.0');
      expect(browser.browserType().name()).toBe('chromium');
      await browser.close();
    },
    20_000,
  );

  it(
    'connectOverCDP fails cleanly without a token',
    async () => {
      const { port } = await startGateway();
      await expect(chromium.connectOverCDP(`http://127.0.0.1:${port}`)).rejects.toThrow(
        /401|Unexpected status/,
      );
    },
    20_000,
  );
});

describe('size limits', () => {
  it('returns 431 for oversized request headers', async () => {
    const { port } = await startGateway();
    const response = await httpRequest({
      port,
      path: '/json/version',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-big': 'a'.repeat(9_000) },
    });
    expect(response.status).toBe(431);
  });

  it('returns 413 for an oversized request body', async () => {
    const { port } = await startGateway();
    const response = await httpRequest({
      port,
      path: '/json/new',
      method: 'PUT',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'x'.repeat(70_000) }),
    });
    expect(response.status).toBe(413);
  });

  it('returns 502 when the upstream Chrome is down', async () => {
    const deadPort = await findDeadPort();
    const { port } = await startGateway({ target: `http://127.0.0.1:${deadPort}` });
    const response = await httpRequest({
      port,
      path: '/json/version',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(502);
  });
});

describe('shutdown', () => {
  it(
    'closes proxied WebSockets and stops accepting connections',
    async () => {
      const { gateway, port } = await startGateway();
      const ws = await connectWs(`ws://127.0.0.1:${port}/devtools/browser/${FAKE_BROWSER_ID}`, {
        authorization: `Bearer ${TOKEN}`,
      });
      const closed = nextClose(ws);

      await Promise.race([
        gateway.close(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('gateway.close() hung')), 3_000).unref(),
        ),
      ]);
      await closed;

      await expect(httpRequest({ port, path: '/healthz' })).rejects.toThrow();
    },
    10_000,
  );
});

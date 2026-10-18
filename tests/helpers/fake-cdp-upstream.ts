/**
 * Test-only stand-in for a local Chrome CDP endpoint: serves the /json/*
 * discovery endpoints and a minimal CDP WebSocket responder sufficient for
 * Playwright's `connectOverCDP` handshake (Browser.getVersion, then generic
 * `{}` results for Target.setAutoAttach / Target.getTargetInfo /
 * Browser.setDownloadBehavior and any other command).
 */
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { completeServerHandshake, WsConnection } from './ws.js';

export interface HttpHit {
  readonly method: string;
  readonly pathname: string;
}

export interface FakeCdpUpstream {
  readonly url: string;
  readonly port: number;
  readonly httpHits: HttpHit[];
  wsConnections(): number;
  close(): Promise<void>;
}

export const FAKE_BROWSER_ID = 'fake-browser-id-0123456789';
export const FAKE_PAGE_ID = 'fake-page-id-0123456789';

export async function startFakeCdpUpstream(): Promise<FakeCdpUpstream> {
  const httpHits: HttpHit[] = [];
  const wsSockets = new Set<Socket>();
  let wsConnectionCount = 0;
  let port = 0;

  const server: Server = createServer((request, response) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', 'http://upstream.invalid').pathname;
    } catch {
      pathname = '/';
    }
    const normalized = pathname.replace(/\/+$/, '') || '/';
    httpHits.push({ method: request.method ?? 'GET', pathname: normalized });

    const json = (status: number, body: unknown): void => {
      const payload = JSON.stringify(body);
      response.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });
      response.end(payload);
    };

    // Respond only after the full request body arrived (like a real server).
    // A request destroyed mid-body by the gateway's size limit never answers.
    request.resume();
    request.on('end', () => respond());

    function respond(): void {
      if (normalized === '/json/version') {
        json(200, {
          'Protocol-Version': '1.3',
          Browser: 'FakeChrome/126.0.6478.0',
          'User-Agent': 'Mozilla/5.0 FakeChrome',
          'WebKit-Version': '537.36',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/${FAKE_BROWSER_ID}`,
        });
        return;
      }
      if (normalized === '/json/list') {
        json(200, [
          {
            id: FAKE_PAGE_ID,
            type: 'page',
            url: 'about:blank',
            title: 'about:blank',
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${FAKE_PAGE_ID}`,
          },
        ]);
        return;
      }
      if (normalized === '/json/new') {
        json(200, {
          id: FAKE_PAGE_ID,
          type: 'page',
          url: 'about:blank',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${FAKE_PAGE_ID}`,
        });
        return;
      }
      json(404, { error: 'not_found' });
    }
  });

  server.on('upgrade', (request, duplex, head) => {
    const socket = duplex as Socket;
    let pathname = '/';
    try {
      pathname = new URL(request.url ?? '/', 'http://upstream.invalid').pathname;
    } catch {
      /* keep default */
    }
    if (!pathname.startsWith('/devtools/')) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    completeServerHandshake(request, socket);
    wsConnectionCount += 1;
    wsSockets.add(socket);
    socket.on('close', () => wsSockets.delete(socket));
    const ws = new WsConnection(socket, false);
    ws.feedHead(head);
    ws.on('message', (data) => {
      let message: { id?: number; method?: string };
      try {
        message = JSON.parse(data) as { id?: number; method?: string };
      } catch {
        return;
      }
      if (message.id === undefined) return; // events/acks need no answer
      if (message.method === 'Browser.getVersion') {
        ws.send(
          JSON.stringify({
            id: message.id,
            result: {
              protocolVersion: '1.3',
              product: 'Chrome/126.0.6478.0',
              revision: '@fake-revision',
              userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) FakeChrome/126.0.6478.0',
              jsVersion: '12.6.229.20',
            },
          }),
        );
        return;
      }
      ws.send(JSON.stringify({ id: message.id, result: {} }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('fake upstream did not bind');
  port = address.port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    httpHits,
    wsConnections: () => wsConnectionCount,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        for (const socket of wsSockets) socket.destroy();
        wsSockets.clear();
        server.closeAllConnections();
      }),
  };
}

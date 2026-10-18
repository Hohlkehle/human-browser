/**
 * Streamable HTTP transport for the MCP server (Stage 5).
 *
 * Serves on a single port:
 * - `/healthz` and `/readyz` — local health answers, no auth, no browser data
 *   (same contract as the Stage 1 scaffold);
 * - `/mcp` — the MCP Streamable HTTP endpoint in STATELESS mode: every POST
 *   gets a fresh McpServer+transport pair (the SDK forbids reusing stateless
 *   transports), which is safe here because all real state lives in the
 *   process-wide browser adapter and human-control gate;
 * - GET/DELETE `/mcp` answer 405 (no standalone SSE stream, no session
 *   termination in stateless mode — both are expected cases per spec);
 * - everything else is 404.
 *
 * Security posture: the listener REFUSES non-loopback bind addresses — this is
 * permanent, not a placeholder. Remote access exists only through the Stage 7
 * tunnel client, which dials OUTBOUND to the cloud edge and forwards back to
 * this loopback endpoint; the MCP port itself is never bound publicly.
 * Request bodies are capped before parsing.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { logger as rootLogger } from '../logging/logger.js';

export const DEFAULT_MAX_MCP_BODY_BYTES = 2 * 1024 * 1024;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::']);

export class McpHttpServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpHttpServerError';
  }
}

export interface McpHttpServerOptions {
  /** Builds a fresh McpServer instance per request (stateless mode). */
  readonly buildMcpServer: () => McpServer;
  readonly listenHost: string;
  readonly listenPort: number;
  readonly maxBodyBytes?: number;
  readonly logger?: Logger;
}

export interface McpHttpServerHandle {
  readonly server: Server;
  /** The actually bound port (useful with port 0 in tests). */
  readonly port: number;
  readonly host: string;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | 'too_large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.byteLength;
      if (size > maxBytes) {
        settled = true;
        // Stop reading; the socket is destroyed after the 413 has flushed.
        req.pause();
        resolve('too_large');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendMethodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, {
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  });
}

export async function createMcpHttpServer(
  options: McpHttpServerOptions,
): Promise<McpHttpServerHandle> {
  if (!LOOPBACK_HOSTS.has(options.listenHost) && !WILDCARD_HOSTS.has(options.listenHost)) {
    throw new McpHttpServerError(
      `MCP HTTP transport refuses to bind "${options.listenHost}": use a loopback address (127.0.0.1 / ::1) or the wildcard (0.0.0.0 / ::); specific non-loopback addresses are rejected — the wildcard binds every interface, and the endpoint has no authentication`,
    );
  }
  const logger = (options.logger ?? rootLogger).child({ component: 'mcp-http' });
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_MCP_BODY_BYTES;
  const liveTransports = new Set<StreamableHTTPServerTransport>();

  const server: Server = createServer((request, response) => {
    const method = request.method ?? 'GET';
    let pathname = '/';
    try {
      pathname = new URL(request.url ?? '/', 'http://mcp.local').pathname;
    } catch {
      sendJson(response, 400, { error: 'bad_request' });
      return;
    }

    if (pathname === '/healthz' || pathname === '/readyz') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (pathname !== '/mcp') {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }

    if (method !== 'POST') {
      // Stateless mode: no standalone GET SSE stream and no session to
      // terminate. 405 is the spec-expected answer and SDK clients handle it.
      sendMethodNotAllowed(response);
      return;
    }

    void (async () => {
      let body: Buffer | 'too_large';
      try {
        body = await readBody(request, maxBodyBytes);
      } catch {
        sendJson(response, 400, { error: 'bad_request' });
        return;
      }
      if (body === 'too_large') {
        if (!response.headersSent) sendJson(response, 413, { error: 'body_too_large' });
        // The client may still be pushing the oversized body: drop the
        // connection once the 413 has gone out (response flushed first).
        response.on('finish', () => {
          if (!request.destroyed) request.destroy();
        });
        return;
      }
      let parsedBody: unknown;
      try {
        parsedBody = body.byteLength === 0 ? undefined : JSON.parse(body.toString('utf8'));
      } catch {
        sendJson(response, 400, { error: 'invalid_json' });
        return;
      }

      // Stateless mode: a fresh transport + server pair per request. The SDK
      // throws when a stateless transport is reused.
      const transport = new StreamableHTTPServerTransport();
      const mcpServer = options.buildMcpServer();
      // The SDK's transport getters type `onclose`/`onerror` as `T | undefined`,
      // which does not satisfy our `exactOptionalPropertyTypes` view of the
      // Transport interface; the runtime contract is identical.
      await mcpServer.connect(transport as unknown as Transport);
      liveTransports.add(transport);
      response.on('close', () => {
        liveTransports.delete(transport);
        void transport.close().catch(() => {});
        void mcpServer.close().catch(() => {});
      });
      await transport.handleRequest(request, response, parsedBody);
    })().catch((error) => {
      logger.error({ err: error }, 'mcp request handling failed');
      if (!response.headersSent) sendJson(response, 500, { error: 'internal_error' });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.listenPort, options.listenHost, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  if (!LOOPBACK_HOSTS.has(options.listenHost)) {
    logger.warn(
      { host: options.listenHost, port: address.port },
      'MCP Streamable HTTP bound to a non-loopback address: the endpoint has NO authentication — anyone who can reach this port can control the browser; restrict access with a firewall',
    );
  }
  logger.info(
    { host: options.listenHost, port: address.port },
    'MCP Streamable HTTP listening (stateless)',
  );

  let closed = false;
  return {
    server,
    port: address.port,
    host: options.listenHost,
    close: async () => {
      if (closed) return;
      closed = true;
      // Terminate in-flight per-request transports (their SSE streams), then
      // the HTTP listener; idle keep-alive sockets are dropped immediately.
      for (const transport of Array.from(liveTransports)) {
        try {
          await transport.close();
        } catch {
          /* already gone */
        }
      }
      liveTransports.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
    },
  };
}

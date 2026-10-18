import { createHash, timingSafeEqual } from 'node:crypto';
import http, {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import httpProxy from 'http-proxy';
import type { Logger } from 'pino';
import { logger as rootLogger } from '../logging/logger.js';
import {
  type CidrRange,
  type ParsedIp,
  formatIp,
  ipInCidr,
  parseCidr,
  parseIp,
} from './ip.js';
import { resolveSecureCdpEndpoint, type ResolvedCdpEndpoint } from './endpoint.js';
import { FixedWindowRateLimiter } from './rate-limit.js';

export type CdpGatewayErrorCode = 'invalid_config' | 'target_forbidden';

export class CdpGatewayError extends Error {
  readonly code: CdpGatewayErrorCode;

  constructor(code: CdpGatewayErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CdpGatewayError';
    this.code = code;
  }
}

export interface CdpGatewayOptions {
  readonly listenHost: string;
  readonly listenPort: number;
  /** Upstream Chrome CDP endpoint, e.g. http://127.0.0.1:9222 */
  readonly target: string;
  readonly bearerToken: string;
  readonly allowedCidrs: readonly string[];
  /** Administrator CIDR policy applied when validating `target` (Stage 2). */
  readonly targetAllowedCidrs?: readonly string[];
  readonly rateLimitWindowMs?: number;
  readonly rateLimitMax?: number;
  readonly maxHeaderBytes?: number;
  readonly maxBodyBytes?: number;
  readonly maxResponseBytes?: number;
  readonly logger?: Logger;
}

export interface CdpGatewayListenInfo {
  readonly host: string;
  readonly port: number;
}

export interface CdpGatewayHandle {
  readonly server: Server;
  listen(): Promise<CdpGatewayListenInfo>;
  close(): Promise<void>;
}

const HEALTH_PATHS = new Set(['/healthz', '/readyz']);
const ALLOWED_HTTP_PATHS = new Set(['/json/version', '/json/list', '/json/new']);
const DEVTOOLS_PREFIX = '/devtools/';

export const DEFAULT_MAX_HEADER_BYTES = 8 * 1024;
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_RATE_LIMIT_MAX = 120;

/**
 * Extracts the pathname from a raw request URL. Query strings and fragments
 * are dropped (they are never logged and never influence allowlist decisions
 * beyond the path), and dot segments are normalized so `/devtools/../x`
 * cannot smuggle a different path past the allowlist.
 */
export function safePathname(rawUrl: string | undefined): string {
  if (!rawUrl) return '/';
  try {
    return new URL(rawUrl, 'http://path.invalid').pathname;
  } catch {
    return '/';
  }
}

/** Strips trailing slashes so `/json/version/` (Playwright) matches `/json/version`. */
export function normalizePathname(pathname: string): string {
  if (!pathname.startsWith('/')) return '/';
  const stripped = pathname.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

/**
 * Log-safe pathname: `/devtools/*` paths carry the secret browser/target id
 * (a connection credential), so only the prefix survives into logs.
 */
export function redactPathnameForLog(pathname: string): string {
  return normalizePathname(pathname).startsWith(DEVTOOLS_PREFIX)
    ? `${DEVTOOLS_PREFIX}[REDACTED]`
    : pathname;
}

/** HTTP paths allowed through the gateway: /json/version, /json/list, /json/new, /devtools/*. */
export function isAllowedHttpPath(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return ALLOWED_HTTP_PATHS.has(normalized) || normalized.startsWith(DEVTOOLS_PREFIX);
}

/** WebSocket upgrade paths: CDP only speaks WS under /devtools/*. */
export function isAllowedUpgradePath(pathname: string): boolean {
  return normalizePathname(pathname).startsWith(DEVTOOLS_PREFIX);
}

/**
 * Constant-time bearer token verification. Both sides are SHA-256 hashed so
 * `timingSafeEqual` gets equal-length inputs regardless of token length.
 */
export function verifyBearerToken(headerValue: string | undefined, expected: string): boolean {
  if (!headerValue || expected === '') return false;
  const match = /^Bearer\s+(\S+)$/i.exec(headerValue.trim());
  if (!match) return false;
  const provided = createHash('sha256').update(match[1] as string).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(provided, expectedHash);
}

/**
 * Parses a remote address and folds IPv4-mapped IPv6 form (::ffff:a.b.c.d)
 * back to IPv4 so a mapped address cannot bypass an IPv4 CIDR allowlist.
 */
export function normalizeRemoteAddress(raw: string | undefined): ParsedIp | undefined {
  if (!raw) return undefined;
  const zoneIndex = raw.indexOf('%');
  const cleaned = zoneIndex === -1 ? raw : raw.slice(0, zoneIndex);
  const ip = parseIp(cleaned);
  if (!ip || ip.version !== 6) return ip;

  const bytes = ip.bytes;
  const leadingZeros = Array.from(bytes.slice(0, 10)).every((value) => value === 0);
  if (leadingZeros && bytes[10] === 0xff && bytes[11] === 0xff) {
    return { bytes: bytes.slice(12, 16), version: 4 };
  }
  return ip;
}

export function isAddressAllowed(ip: ParsedIp | undefined, ranges: readonly CidrRange[]): boolean {
  if (!ip) return false;
  return ranges.some((range) => ipInCidr(ip, range));
}

function rewriteOneDebuggerUrl(raw: string, host: string): string {
  try {
    const parsed = new URL(raw);
    if (!['ws:', 'wss:', 'http:', 'https:'].includes(parsed.protocol)) return raw;
    // Clients must connect back through the gateway, never straight to the
    // upstream Chrome port. The path carries the target id and is preserved.
    return `ws://${host}${parsed.pathname}`;
  } catch {
    return raw;
  }
}

/**
 * Rewrites every `webSocketDebuggerUrl` in a `/json/*` response so clients
 * (e.g. Playwright `connectOverCDP`) connect back through the gateway
 * instead of bypassing it via the upstream address.
 */
export function rewriteDebuggerUrls(value: unknown, host: string): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteDebuggerUrls(item, host));
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] =
        key === 'webSocketDebuggerUrl' && typeof entry === 'string'
          ? rewriteOneDebuggerUrl(entry, host)
          : rewriteDebuggerUrls(entry, host);
    }
    return result;
  }
  return value;
}

function headerSize(request: IncomingMessage): number {
  let total = request.url ? request.url.length : 0;
  for (const [name, value] of Object.entries(request.headers)) {
    total += name.length + 4; // ": " and CRLF
    if (typeof value === 'string') total += value.length;
    else if (Array.isArray(value)) {
      for (const entry of value) total += entry.length + 2;
    }
  }
  return total;
}

function respondJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (response.headersSent || response.writableEnded) {
    response.destroy();
    return;
  }
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

/**
 * Creates the authenticated CDP gateway. Refuses to be constructed without a
 * bearer token and a non-empty CIDR allowlist, validates and pins the
 * upstream target through the Stage 2 secure endpoint resolver, and proxies
 * only the allowlisted CDP paths.
 */
export async function createCdpGateway(options: CdpGatewayOptions): Promise<CdpGatewayHandle> {
  if (!options.bearerToken) {
    throw new CdpGatewayError('invalid_config', 'Gateway refuses to start without a bearer token');
  }
  if (options.allowedCidrs.length === 0) {
    throw new CdpGatewayError('invalid_config', 'Gateway refuses to start without allowedCidrs');
  }

  const ranges: CidrRange[] = [];
  for (const entry of options.allowedCidrs) {
    const range = parseCidr(entry);
    if (!range) throw new CdpGatewayError('invalid_config', `Invalid CIDR in allowedCidrs: ${entry}`);
    ranges.push(range);
  }

  const maxHeaderBytes = options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const logger = options.logger ?? rootLogger.child({ component: 'cdp-gateway' });
  const limiter = new FixedWindowRateLimiter({
    windowMs: options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
    max: options.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX,
  });

  // Validate the upstream target with the Stage 2 resolver and pin the checked
  // address: DNS is never consulted again for the proxy connection.
  let resolved: ResolvedCdpEndpoint;
  try {
    resolved = await resolveSecureCdpEndpoint(options.target, {
      policy: { allowedCidrs: options.targetAllowedCidrs ?? [] },
    });
  } catch (cause) {
    throw new CdpGatewayError(
      'target_forbidden',
      `Gateway target "${options.target}" is not an allowed CDP endpoint`,
      { cause },
    );
  }

  const pinnedHost = resolved.pinnedAddresses[0] ?? resolved.host;
  const hostForUrl = pinnedHost.includes(':') ? `[${pinnedHost}]` : pinnedHost;
  const upstreamScheme = resolved.scheme === 'https' || resolved.scheme === 'wss' ? 'https' : 'http';
  const targetUrl = `${upstreamScheme}://${hostForUrl}:${resolved.port}`;

  // Dedicated no-keep-alive agent: upstream connections are closed right after
  // each response, so nothing lingers past shutdown and nothing is shared with
  // the rest of the process.
  const upstreamAgent =
    upstreamScheme === 'https'
      ? new https.Agent({ keepAlive: false })
      : new http.Agent({ keepAlive: false });

  const proxy = httpProxy.createProxyServer({
    target: targetUrl,
    selfHandleResponse: true,
    changeOrigin: false,
    xfwd: false,
    agent: upstreamAgent,
  });

  const upgradedSockets = new Set<Socket>();
  const clientHosts = new WeakMap<IncomingMessage, string>();
  let shuttingDown = false;
  let closePromise: Promise<void> | undefined;

  const server = createServer((request, response) => {
    // Query strings are stripped before any logging or routing decision.
    const pathname = safePathname(request.url);
    const socket = request.socket as Socket;
    const remoteIp = normalizeRemoteAddress(socket.remoteAddress);

    if (shuttingDown) {
      respondJson(response, 503, { error: 'shutting_down' });
      return;
    }
    if (!isAddressAllowed(remoteIp, ranges)) {
      logger.warn({ reason: 'cidr_denied', pathname: redactPathnameForLog(pathname) }, 'gateway request denied');
      respondJson(response, 403, { error: 'forbidden' });
      return;
    }
    const decision = limiter.hit(remoteIp ? formatIp(remoteIp) : 'unknown');
    if (!decision.allowed) {
      response.setHeader('retry-after', String(Math.ceil(decision.retryAfterMs / 1000)));
      respondJson(response, 429, { error: 'rate_limited' });
      return;
    }
    if (HEALTH_PATHS.has(pathname)) {
      // Health endpoints answer locally and never expose Chrome data.
      respondJson(response, 200, pathname === '/readyz' ? { status: 'ready' } : { status: 'ok' });
      return;
    }
    if (headerSize(request) > maxHeaderBytes) {
      respondJson(response, 431, { error: 'headers_too_large' });
      return;
    }
    if (!verifyBearerToken(request.headers.authorization, options.bearerToken)) {
      logger.warn({ reason: 'unauthorized', pathname: redactPathnameForLog(pathname) }, 'gateway request denied');
      response.setHeader('www-authenticate', 'Bearer realm="cdp-gateway"');
      respondJson(response, 401, { error: 'unauthorized' });
      return;
    }
    if (!isAllowedHttpPath(pathname)) {
      respondJson(response, 404, { error: 'not_found' });
      return;
    }

    let bodyBytes = 0;
    let bodyLimited = false;
    request.on('data', (chunk: Buffer) => {
      if (bodyLimited) return;
      bodyBytes += chunk.length;
      if (bodyBytes > maxBodyBytes) {
        bodyLimited = true;
        respondJson(response, 413, { error: 'body_too_large' });
        // Flush the 413 to the client before tearing the connection down.
        socket.destroySoon();
      }
    });

    // Remember the client-facing host for debugger-URL rewriting, then make
    // sure the client's bearer token never reaches the upstream.
    clientHosts.set(request, request.headers.host ?? `${options.listenHost}:${options.listenPort}`);
    delete request.headers.authorization;
    request.headers.host = resolved.hostHeader;
    proxy.web(request, response);
  });

  server.on('upgrade', (request, duplex, head) => {
    const socket = duplex as Socket;
    const pathname = safePathname(request.url);
    const remoteIp = normalizeRemoteAddress(socket.remoteAddress);

    const deny = (status: number, statusText: string, reason: string, extra = ''): void => {
      logger.warn({ reason, pathname: redactPathnameForLog(pathname) }, 'gateway upgrade denied');
      socket.write(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\n${extra}\r\n`);
      // destroySoon flushes the rejection response before closing.
      socket.destroySoon();
    };

    if (shuttingDown) {
      deny(503, 'Service Unavailable', 'shutting_down');
      return;
    }
    if (!isAddressAllowed(remoteIp, ranges)) {
      deny(403, 'Forbidden', 'cidr_denied');
      return;
    }
    const decision = limiter.hit(remoteIp ? formatIp(remoteIp) : 'unknown');
    if (!decision.allowed) {
      deny(
        429,
        'Too Many Requests',
        'rate_limited',
        `Retry-After: ${Math.ceil(decision.retryAfterMs / 1000)}\r\n`,
      );
      return;
    }
    if (!verifyBearerToken(request.headers.authorization, options.bearerToken)) {
      deny(401, 'Unauthorized', 'unauthorized', 'WWW-Authenticate: Bearer realm="cdp-gateway"\r\n');
      return;
    }
    if (!isAllowedUpgradePath(pathname)) {
      deny(404, 'Not Found', 'not_found');
      return;
    }
    if (headerSize(request) > maxHeaderBytes) {
      deny(431, 'Request Header Fields Too Large', 'headers_too_large');
      return;
    }

    delete request.headers.authorization;
    request.headers.host = resolved.hostHeader;

    // Track proxied WebSockets so shutdown can terminate them explicitly;
    // server.close() alone would not wait for or drop upgraded sockets.
    upgradedSockets.add(socket);
    socket.on('close', () => upgradedSockets.delete(socket));
    proxy.ws(request, socket, head);
  });

  proxy.on('proxyRes', (proxyRes, request, response) => {
    const pathname = safePathname(request.url);
    const clientHost =
      clientHosts.get(request) ?? `${options.listenHost}:${options.listenPort}`;
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;

    proxyRes.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxResponseBytes) {
        overflow = true;
        proxyRes.destroy();
        return;
      }
      chunks.push(chunk);
    });
    proxyRes.on('error', () => {
      if (!response.headersSent && !response.writableEnded) {
        respondJson(response, 502, { error: 'bad_gateway' });
      } else {
        response.destroy();
      }
    });
    proxyRes.on('end', () => {
      // The response may already be finalized (e.g. a 413 body-limit answer
      // raced the upstream response); never write twice.
      if (response.headersSent || response.writableEnded) {
        response.destroy();
        return;
      }
      if (overflow) {
        respondJson(response, 502, { error: 'bad_gateway' });
        return;
      }
      const body = Buffer.concat(chunks);
      if (pathname.startsWith('/json')) {
        try {
          const parsed: unknown = JSON.parse(body.toString('utf8'));
          const rewritten = JSON.stringify(rewriteDebuggerUrls(parsed, clientHost));
          response.writeHead(proxyRes.statusCode ?? 502, {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(rewritten),
            'cache-control': 'no-store',
          });
          response.end(rewritten);
          return;
        } catch {
          // Non-JSON body: forward unchanged below.
        }
      }
      const headers: Record<string, string | number> = { 'content-length': body.length };
      const contentType = proxyRes.headers['content-type'];
      if (contentType) headers['content-type'] = contentType;
      response.writeHead(proxyRes.statusCode ?? 502, headers);
      response.end(body);
    });
  });

  proxy.on('error', (error, request, response) => {
    logger.warn(
      {
        reason: 'upstream_error',
        message: error.message,
        pathname: redactPathnameForLog(safePathname(request.url)),
      },
      'proxy error',
    );
    const serverResponse = response as Partial<ServerResponse>;
    if (typeof serverResponse.writeHead === 'function') {
      if (!serverResponse.headersSent && !serverResponse.writableEnded) {
        respondJson(serverResponse as ServerResponse, 502, { error: 'bad_gateway' });
      } else {
        (response as ServerResponse).destroy();
      }
      return;
    }
    (response as Socket).destroy();
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;

  async function listen(): Promise<CdpGatewayListenInfo> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once('error', onError);
      server.listen(options.listenPort, options.listenHost, () => {
        server.off('error', onError);
        resolve();
      });
    });
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : options.listenPort;
    // Only host/port are logged: never the token, CIDRs, or the target.
    logger.info({ host: options.listenHost, port }, 'CDP gateway listening');
    return { host: options.listenHost, port };
  }

  function close(): Promise<void> {
    if (!closePromise) {
      closePromise = (async () => {
        shuttingDown = true;
        // Terminate proxied WebSockets first so shutdown cannot hang on them.
        for (const socket of upgradedSockets) socket.destroy();
        upgradedSockets.clear();
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        // Drop idle keep-alive sockets immediately; otherwise server.close()
        // would wait for them forever. In-flight requests still finish.
        server.closeIdleConnections();
        await closed;
        // http-proxy@1.18 quirk: close(callback) never invokes the callback
        // when the proxy owns no server, so it must not be awaited. The
        // upstream connections are ours to clean up via the dedicated agent.
        proxy.close();
        upstreamAgent.destroy();
        logger.info('CDP gateway stopped');
      })();
    }
    return closePromise;
  }

  return { server, listen, close };
}

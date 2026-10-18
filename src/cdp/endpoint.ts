import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import {
  type CidrRange,
  type IpClass,
  type ParsedIp,
  classifyIp,
  formatIp,
  ipInCidr,
  isDefaultAllowed,
  parseCidr,
  parseIp,
} from './ip.js';

export type CdpErrorCode =
  | 'invalid_url'
  | 'unsupported_scheme'
  | 'credentials_forbidden'
  | 'dns_resolution_failed'
  | 'address_forbidden'
  | 'probe_failed'
  | 'invalid_version_response'
  | 'missing_protocol_version'
  | 'timeout'
  | 'aborted';

export class CdpEndpointError extends Error {
  readonly code: CdpErrorCode;

  constructor(code: CdpErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CdpEndpointError';
    this.code = code;
  }
}

export type CdpScheme = 'http' | 'https' | 'ws' | 'wss';

const ALLOWED_SCHEMES: readonly CdpScheme[] = ['http', 'https', 'ws', 'wss'];
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_VERSION_BODY_BYTES = 64 * 1024;

/** Injectable DNS resolver so tests can simulate hostile DNS responses. */
export type LookupFn = (
  hostname: string,
  options: dns.LookupAllOptions,
) => Promise<dns.LookupAddress[]>;

const defaultLookup: LookupFn = (hostname, options) => dns.promises.lookup(hostname, options);

export interface CdpEndpointPolicy {
  /**
   * Administrator-explicit allowlist. Entries may extend the default
   * loopback/RFC1918 allowance, e.g. to permit a specific public address.
   */
  readonly allowedCidrs?: readonly string[];
}

export interface ResolvedCdpEndpoint {
  readonly originalUrl: string;
  readonly scheme: CdpScheme;
  /** Hostname or IP literal without port and without IPv6 brackets. */
  readonly host: string;
  readonly port: number;
  /** `Host` header value to present to the remote endpoint. */
  readonly hostHeader: string;
  /** True when `host` is an IP literal and no DNS was involved. */
  readonly isIpLiteral: boolean;
  /** Validated addresses the connection is pinned to (anti DNS-rebinding). */
  readonly pinnedAddresses: readonly string[];
  /** HTTP(S) origin used for the `/json/version` probe. */
  readonly httpOrigin: string;
}

export interface CdpVersionInfo {
  readonly protocolVersion: string;
  readonly browser?: string;
  /**
   * The `User-Agent` reported by `/json/version`. Headless Chrome reports a
   * UA containing `HeadlessChrome`, which Stage 6 uses to enforce visible
   * mode. Never logged on its own (it can carry version fingerprint detail).
   */
  readonly userAgent?: string;
  readonly webSocketDebuggerUrlPresent: boolean;
  /** Never the raw URL: the path contains a secret browser/target id. */
  readonly redactedDebuggerUrl?: string;
}

export interface ResolveOptions {
  readonly policy?: CdpEndpointPolicy;
  readonly lookup?: LookupFn;
  readonly signal?: AbortSignal;
}

export interface ProbeOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Extra HTTP headers for the probe request, e.g. the `Authorization` header
   * required by an authenticated CDP gateway. A caller-supplied `host` header
   * is always ignored: the validated host header stays pinned.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CdpEndpointError('aborted', 'CDP endpoint validation aborted');
  }
}

function parseAllowedCidrs(policy: CdpEndpointPolicy | undefined): CidrRange[] {
  const ranges: CidrRange[] = [];
  for (const entry of policy?.allowedCidrs ?? []) {
    const range = parseCidr(entry);
    if (!range) {
      throw new CdpEndpointError('invalid_url', `Invalid CIDR in allowedCidrs: ${entry}`);
    }
    ranges.push(range);
  }
  return ranges;
}

function isAllowed(ip: ParsedIp, ipClass: IpClass, allowedCidrs: readonly CidrRange[]): boolean {
  if (isDefaultAllowed(ipClass)) return true;
  return allowedCidrs.some((range) => ipInCidr(ip, range));
}

function schemeFromProtocol(protocol: string): CdpScheme {
  return protocol.slice(0, -1) as CdpScheme;
}

function httpSchemeFor(scheme: CdpScheme): 'http' | 'https' {
  return scheme === 'https' || scheme === 'wss' ? 'https' : 'http';
}

function defaultPortFor(scheme: CdpScheme): number {
  return scheme === 'https' || scheme === 'wss' ? 443 : 80;
}

/**
 * Validates a CDP endpoint URL and resolves it securely.
 *
 * - Only `http/https/ws/wss` schemes; credentials in the URL are forbidden.
 * - Every DNS answer is classified; the whole endpoint is rejected if ANY
 *   answer is link-local, multicast, broadcast, public, or otherwise not
 *   allowed (mixed-record attacks).
 * - The validated addresses are returned as `pinnedAddresses`: later
 *   connections must use them directly so the address cannot be swapped
 *   after validation (DNS rebinding).
 */
export async function resolveSecureCdpEndpoint(
  endpoint: string,
  options: ResolveOptions = {},
): Promise<ResolvedCdpEndpoint> {
  throwIfAborted(options.signal);
  const allowedCidrs = parseAllowedCidrs(options.policy);

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new CdpEndpointError('invalid_url', `CDP endpoint is not a valid URL: ${endpoint}`);
  }

  const scheme = schemeFromProtocol(url.protocol);
  if (!ALLOWED_SCHEMES.includes(scheme)) {
    throw new CdpEndpointError(
      'unsupported_scheme',
      `CDP endpoint scheme "${url.protocol}" is not allowed; use http/https/ws/wss`,
    );
  }

  if (url.username !== '' || url.password !== '') {
    throw new CdpEndpointError(
      'credentials_forbidden',
      'CDP endpoint URL must not contain credentials',
    );
  }

  const host = url.hostname;
  if (host === '') {
    throw new CdpEndpointError('invalid_url', 'CDP endpoint URL must contain a host');
  }
  const port = url.port === '' ? defaultPortFor(scheme) : Number.parseInt(url.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CdpEndpointError('invalid_url', `CDP endpoint port is invalid: ${url.port}`);
  }

  const httpScheme = httpSchemeFor(scheme);
  const hostHeader = url.host; // keeps IPv6 brackets and port
  const base = {
    originalUrl: endpoint,
    scheme,
    host,
    port,
    hostHeader,
    httpOrigin: `${httpScheme}://${hostHeader}`,
  };

  const literalVersion = isIP(host);
  if (literalVersion !== 0) {
    const ip = parseIp(host);
    if (!ip) {
      throw new CdpEndpointError('invalid_url', `CDP endpoint IP literal is unparseable: ${host}`);
    }
    const ipClass = classifyIp(ip);
    if (!isAllowed(ip, ipClass, allowedCidrs)) {
      throw new CdpEndpointError(
        'address_forbidden',
        `CDP endpoint address ${host} (${ipClass}) is not allowed`,
      );
    }
    return { ...base, isIpLiteral: true, pinnedAddresses: [host] };
  }

  // Hostname: resolve all A/AAAA records and validate every single answer.
  let answers: dns.LookupAddress[];
  try {
    answers = await (options.lookup ?? defaultLookup)(host, { all: true, verbatim: true });
  } catch (cause) {
    throw new CdpEndpointError(
      'dns_resolution_failed',
      `DNS resolution failed for CDP endpoint host "${host}"`,
      { cause },
    );
  }
  throwIfAborted(options.signal);

  if (answers.length === 0) {
    throw new CdpEndpointError(
      'dns_resolution_failed',
      `DNS resolution returned no addresses for "${host}"`,
    );
  }

  const pinned: string[] = [];
  for (const answer of answers) {
    const ip = parseIp(answer.address);
    if (!ip) {
      throw new CdpEndpointError(
        'dns_resolution_failed',
        `DNS returned an unparseable address for "${host}": ${answer.address}`,
      );
    }
    const ipClass = classifyIp(ip);
    if (!isAllowed(ip, ipClass, allowedCidrs)) {
      throw new CdpEndpointError(
        'address_forbidden',
        `CDP endpoint host "${host}" resolves to forbidden address ` +
          `${formatIp(ip)} (${ipClass}); refusing to connect`,
      );
    }
    pinned.push(answer.address);
  }

  return { ...base, isIpLiteral: false, pinnedAddresses: pinned };
}

/**
 * Redacts a `webSocketDebuggerUrl` for logging: only scheme and host survive,
 * the path (browser/target secret id) is always stripped.
 */
export function redactDebuggerUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.host}/[REDACTED]`;
  } catch {
    return '[REDACTED]';
  }
}

interface PinnedRequestResult {
  readonly statusCode: number;
  readonly body: string;
}

function probeHeaders(
  resolved: ResolvedCdpEndpoint,
  extra: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = { host: resolved.hostHeader, accept: 'application/json' };
  for (const [name, value] of Object.entries(extra ?? {})) {
    // The validated host header can never be overridden by the caller.
    if (name.toLowerCase() === 'host') continue;
    headers[name] = value;
  }
  return headers;
}

function requestPinnedVersion(
  resolved: ResolvedCdpEndpoint,
  address: string,
  signal: AbortSignal,
  callerSignal: AbortSignal | undefined,
  headers: Readonly<Record<string, string>> | undefined,
): Promise<PinnedRequestResult> {
  const httpScheme = httpSchemeFor(resolved.scheme);
  const library = httpScheme === 'https' ? https : http;
  const ipVersion = isIP(address);

  return new Promise<PinnedRequestResult>((resolve, reject) => {
    const requestOptions: http.RequestOptions = {
      // Connect to the validated address directly; DNS is never consulted
      // again, so a rebinding response cannot redirect the connection.
      host: address,
      port: resolved.port,
      method: 'GET',
      path: '/json/version',
      headers: probeHeaders(resolved, headers),
      signal,
    };
    if (ipVersion !== 0) requestOptions.family = ipVersion;
    if (httpScheme === 'https' && !resolved.isIpLiteral) {
      // TLS SNI/identity stay bound to the original hostname, not the pinned IP.
      (requestOptions as https.RequestOptions).servername = resolved.host;
    }

    const request = library.request(requestOptions, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_VERSION_BODY_BYTES) {
          response.destroy();
          reject(
            new CdpEndpointError(
              'invalid_version_response',
              '/json/version response exceeded size limit',
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      response.on('error', (cause) => {
        reject(new CdpEndpointError('probe_failed', 'CDP version response stream failed', { cause }));
      });
    });

    request.on('error', (cause: NodeJS.ErrnoException) => {
      if (callerSignal?.aborted) {
        reject(new CdpEndpointError('aborted', 'CDP version probe aborted', { cause }));
        return;
      }
      if (signal.aborted || cause.name === 'AbortError' || cause.code === 'ABORT_ERR') {
        reject(new CdpEndpointError('timeout', 'CDP version probe timed out', { cause }));
        return;
      }
      reject(
        new CdpEndpointError('probe_failed', `CDP version probe failed: ${cause.message}`, { cause }),
      );
    });
    request.end();
  });
}

/**
 * Fetches and parses `/json/version` on a previously resolved (pinned)
 * endpoint, trying every pinned address in order for transport failures.
 */
async function fetchVersionRecord(
  resolved: ResolvedCdpEndpoint,
  options: ProbeOptions = {},
): Promise<Record<string, unknown>> {
  throwIfAborted(options.signal);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([timeoutSignal, options.signal])
    : timeoutSignal;

  let lastError: unknown;
  for (const address of resolved.pinnedAddresses) {
    if (options.signal?.aborted) {
      throw new CdpEndpointError('aborted', 'CDP version probe aborted');
    }
    try {
      const { statusCode, body } = await requestPinnedVersion(
        resolved,
        address,
        signal,
        options.signal,
        options.headers,
      );
      if (statusCode !== 200) {
        throw new CdpEndpointError(
          'probe_failed',
          `/json/version returned HTTP ${statusCode} from ${address}`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch (cause) {
        throw new CdpEndpointError(
          'invalid_version_response',
          '/json/version did not return valid JSON',
          { cause },
        );
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new CdpEndpointError(
          'invalid_version_response',
          '/json/version did not return a JSON object',
        );
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      // Abort/timeout/rejection are terminal; only transport errors try the
      // next pinned address.
      if (error instanceof CdpEndpointError && error.code !== 'probe_failed') throw error;
      lastError = error;
    }
  }

  throw (
    lastError instanceof CdpEndpointError
      ? lastError
      : new CdpEndpointError('probe_failed', 'CDP version probe failed on all pinned addresses')
  );
}

/**
 * Probes `/json/version` on a previously resolved (pinned) endpoint and
 * verifies that a CDP `Protocol-Version` is reported. The raw
 * `webSocketDebuggerUrl` is never returned or logged; only a redacted form.
 */
export async function probeCdpVersion(
  resolved: ResolvedCdpEndpoint,
  options: ProbeOptions = {},
): Promise<CdpVersionInfo> {
  const record = await fetchVersionRecord(resolved, options);
  const protocolVersion = record['Protocol-Version'];
  if (typeof protocolVersion !== 'string' || protocolVersion.trim() === '') {
    throw new CdpEndpointError(
      'missing_protocol_version',
      '/json/version is missing Protocol-Version',
    );
  }

  const debuggerUrl = record['webSocketDebuggerUrl'];
  const versionInfo: {
    protocolVersion: string;
    browser?: string;
    userAgent?: string;
    webSocketDebuggerUrlPresent: boolean;
    redactedDebuggerUrl?: string;
  } = {
    protocolVersion,
    webSocketDebuggerUrlPresent: typeof debuggerUrl === 'string' && debuggerUrl !== '',
  };
  if (typeof record['Browser'] === 'string') versionInfo.browser = record['Browser'];
  if (typeof record['User-Agent'] === 'string' && record['User-Agent'] !== '') {
    versionInfo.userAgent = record['User-Agent'];
  }
  if (typeof debuggerUrl === 'string' && debuggerUrl !== '') {
    versionInfo.redactedDebuggerUrl = redactDebuggerUrl(debuggerUrl);
  }
  return versionInfo;
}

/**
 * Fetches `/json/version` on a previously resolved (pinned) endpoint and
 * returns the raw `webSocketDebuggerUrl` when present.
 *
 * SECURITY: the URL path carries the browser's secret target id — it is a
 * connection credential. Callers may use it in-process to pin the CDP
 * WebSocket connection to the validated address, but must never log it or
 * hand it to external consumers (see `redactDebuggerUrl`).
 */
export async function fetchCdpWebSocketDebuggerUrl(
  resolved: ResolvedCdpEndpoint,
  options: ProbeOptions = {},
): Promise<string | undefined> {
  const record = await fetchVersionRecord(resolved, options);
  const debuggerUrl = record['webSocketDebuggerUrl'];
  return typeof debuggerUrl === 'string' && debuggerUrl !== '' ? debuggerUrl : undefined;
}

/**
 * One-shot secure validation: URL policy + DNS classification + pinning +
 * `/json/version` probe with `Protocol-Version` verification.
 */
export async function validateCdpEndpoint(
  endpoint: string,
  options: ResolveOptions & ProbeOptions & { readonly policy?: CdpEndpointPolicy } = {},
): Promise<{ resolved: ResolvedCdpEndpoint; version: CdpVersionInfo }> {
  const resolved = await resolveSecureCdpEndpoint(endpoint, options);
  const version = await probeCdpVersion(resolved, options);
  return { resolved, version };
}

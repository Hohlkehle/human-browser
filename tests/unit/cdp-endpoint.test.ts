import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import dns from 'node:dns';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CdpEndpointError,
  fetchCdpWebSocketDebuggerUrl,
  probeCdpVersion,
  redactDebuggerUrl,
  resolveSecureCdpEndpoint,
  validateCdpEndpoint,
  type LookupFn,
} from '../../src/cdp/endpoint.js';

const SECRET_ID = 'secret-browser-id-12345';

const servers: Server[] = [];

function startVersionServer(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function jsonVersionServer(): Promise<number> {
  return startVersionServer((request, response) => {
    // Mirror the real Host header so the debugger URL matches the probe target.
    const host = request.headers.host ?? '127.0.0.1';
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        Browser: 'Chrome/130.0.0.0',
        'Protocol-Version': '1.3',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        webSocketDebuggerUrl: `ws://${host}/devtools/browser/${SECRET_ID}`,
      }),
    );
  });
}

function staticLookup(addresses: dns.LookupAddress[]): LookupFn {
  return async () => addresses;
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function expectCdpError(
  fn: () => Promise<unknown>,
  code: string,
): Promise<CdpEndpointError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CdpEndpointError);
    expect((error as CdpEndpointError).code).toBe(code);
    return error as CdpEndpointError;
  }
  throw new Error(`expected CdpEndpointError(${code}) but no error was thrown`);
}

describe('resolveSecureCdpEndpoint: URL policy', () => {
  it('accepts the local Chrome endpoint and the user LAN endpoint', async () => {
    const local = await resolveSecureCdpEndpoint('http://127.0.0.1:9222');
    expect(local.scheme).toBe('http');
    expect(local.port).toBe(9222);
    expect(local.pinnedAddresses).toEqual(['127.0.0.1']);

    const lan = await resolveSecureCdpEndpoint('http://10.252.150.2:9229');
    expect(lan.pinnedAddresses).toEqual(['10.252.150.2']);
  });

  it('accepts ws/wss schemes', async () => {
    const ws = await resolveSecureCdpEndpoint('ws://127.0.0.1:9222');
    expect(ws.scheme).toBe('ws');
    expect(ws.httpOrigin).toBe('http://127.0.0.1:9222');

    const wss = await resolveSecureCdpEndpoint('wss://127.0.0.1:9222');
    expect(wss.httpOrigin).toBe('https://127.0.0.1:9222');
  });

  it('rejects unsupported schemes', async () => {
    await expectCdpError(() => resolveSecureCdpEndpoint('ftp://127.0.0.1:9222'), 'unsupported_scheme');
    await expectCdpError(() => resolveSecureCdpEndpoint('file:///etc/passwd'), 'unsupported_scheme');
    await expectCdpError(
      () => resolveSecureCdpEndpoint('javascript:alert(1)'),
      'unsupported_scheme',
    );
  });

  it('rejects credentials in the URL', async () => {
    await expectCdpError(() => resolveSecureCdpEndpoint('http://user:pass@127.0.0.1:9222'), 'credentials_forbidden');
    await expectCdpError(() => resolveSecureCdpEndpoint('http://:pass@127.0.0.1:9222'), 'credentials_forbidden');
  });

  it('rejects malformed URLs', async () => {
    await expectCdpError(() => resolveSecureCdpEndpoint('not a url'), 'invalid_url');
    await expectCdpError(() => resolveSecureCdpEndpoint('http://'), 'invalid_url');
  });

  it('rejects public, link-local, multicast and broadcast IPv4 literals', async () => {
    await expectCdpError(() => resolveSecureCdpEndpoint('http://8.8.8.8:9222'), 'address_forbidden');
    await expectCdpError(
      () => resolveSecureCdpEndpoint('http://93.184.216.34:9222'),
      'address_forbidden',
    );
    await expectCdpError(
      () => resolveSecureCdpEndpoint('http://169.254.10.10:9222'),
      'address_forbidden',
    );
    await expectCdpError(
      () => resolveSecureCdpEndpoint('http://224.0.0.1:9222'),
      'address_forbidden',
    );
    await expectCdpError(
      () => resolveSecureCdpEndpoint('http://255.255.255.255:9222'),
      'address_forbidden',
    );
    await expectCdpError(() => resolveSecureCdpEndpoint('http://0.0.0.1:9222'), 'address_forbidden');
  });

  it('rejects public IPv6 literals but accepts loopback IPv6', async () => {
    await expectCdpError(
      () => resolveSecureCdpEndpoint('http://[2001:4860:4860::8888]:9222'),
      'address_forbidden',
    );
    await expectCdpError(
      () => resolveSecureCdpEndpoint('http://[::ffff:8.8.8.8]:9222'),
      'address_forbidden',
    );
    const loopback = await resolveSecureCdpEndpoint('http://[::1]:9222');
    expect(loopback.pinnedAddresses).toEqual(['::1']);
  });

  it('allows an explicit administrator CIDR to permit a public address', async () => {
    const resolved = await resolveSecureCdpEndpoint('http://203.0.113.7:9222', {
      policy: { allowedCidrs: ['203.0.113.0/24'] },
    });
    expect(resolved.pinnedAddresses).toEqual(['203.0.113.7']);
  });

  it('rejects invalid CIDRs in the policy', async () => {
    await expectCdpError(
      () =>
        resolveSecureCdpEndpoint('http://127.0.0.1:9222', {
          policy: { allowedCidrs: ['not-a-cidr'] },
        }),
      'invalid_url',
    );
  });
});

describe('resolveSecureCdpEndpoint: hostname resolution', () => {
  it('accepts a hostname that resolves to loopback', async () => {
    const resolved = await resolveSecureCdpEndpoint('http://chrome.local:9222', {
      lookup: staticLookup([{ address: '127.0.0.1', family: 4 }]),
    });
    expect(resolved.isIpLiteral).toBe(false);
    expect(resolved.pinnedAddresses).toEqual(['127.0.0.1']);
  });

  it('rejects an arbitrary public hostname', async () => {
    await expectCdpError(
      () =>
        resolveSecureCdpEndpoint('http://example.com:9222', {
          lookup: staticLookup([{ address: '93.184.216.34', family: 4 }]),
        }),
      'address_forbidden',
    );
  });

  it('rejects mixed records when any answer is forbidden', async () => {
    await expectCdpError(
      () =>
        resolveSecureCdpEndpoint('http://mixed.local:9222', {
          lookup: staticLookup([
            { address: '127.0.0.1', family: 4 },
            { address: '8.8.8.8', family: 4 },
          ]),
        }),
      'address_forbidden',
    );
  });

  it('rejects hostnames resolving to link-local or IPv6 public addresses', async () => {
    await expectCdpError(
      () =>
        resolveSecureCdpEndpoint('http://metadata.local:9222', {
          lookup: staticLookup([{ address: '169.254.169.254', family: 4 }]),
        }),
      'address_forbidden',
    );
    await expectCdpError(
      () =>
        resolveSecureCdpEndpoint('http://v6.local:9222', {
          lookup: staticLookup([{ address: '2606:4700:4700::1111', family: 6 }]),
        }),
      'address_forbidden',
    );
  });

  it('reports DNS failures as clear errors', async () => {
    const failing: LookupFn = async () => {
      throw new Error('ENOTFOUND');
    };
    await expectCdpError(
      () => resolveSecureCdpEndpoint('http://missing.local:9222', { lookup: failing }),
      'dns_resolution_failed',
    );
  });

  it('rejects empty DNS answers', async () => {
    await expectCdpError(
      () => resolveSecureCdpEndpoint('http://empty.local:9222', { lookup: staticLookup([]) }),
      'dns_resolution_failed',
    );
  });
});

describe('probeCdpVersion', () => {
  it('verifies /json/version and never exposes the raw webSocketDebuggerUrl', async () => {
    const port = await jsonVersionServer();
    const resolved = await resolveSecureCdpEndpoint(`http://127.0.0.1:${port}`);
    const version = await probeCdpVersion(resolved, { timeoutMs: 5000 });

    expect(version.protocolVersion).toBe('1.3');
    expect(version.browser).toBe('Chrome/130.0.0.0');
    // Stage 6 visible-mode enforcement relies on the reported User-Agent.
    expect(version.userAgent).toContain('Chrome/130.0.0.0');
    expect(version.userAgent).not.toContain('HeadlessChrome');
    expect(version.webSocketDebuggerUrlPresent).toBe(true);
    expect(version.redactedDebuggerUrl).toBe(`ws://127.0.0.1:${port}/[REDACTED]`);
    expect(JSON.stringify(version)).not.toContain(SECRET_ID);
  });

  it('captures a headless User-Agent marker when reported', async () => {
    const port = await startVersionServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          Browser: 'HeadlessChrome/130.0.0.0',
          'Protocol-Version': '1.3',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 HeadlessChrome/130.0.0.0 Safari/537.36',
        }),
      );
    });
    const resolved = await resolveSecureCdpEndpoint(`http://127.0.0.1:${port}`);
    const version = await probeCdpVersion(resolved, { timeoutMs: 5000 });
    expect(version.userAgent).toContain('HeadlessChrome');
  });

  it('fails when Protocol-Version is missing', async () => {
    const port = await startVersionServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ Browser: 'NotChrome' }));
    });
    const resolved = await resolveSecureCdpEndpoint(`http://127.0.0.1:${port}`);
    await expectCdpError(() => probeCdpVersion(resolved), 'missing_protocol_version');
  });

  it('fails on non-JSON or non-object bodies', async () => {
    const textPort = await startVersionServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('hello');
    });
    const textResolved = await resolveSecureCdpEndpoint(`http://127.0.0.1:${textPort}`);
    await expectCdpError(() => probeCdpVersion(textResolved), 'invalid_version_response');

    const arrayPort = await startVersionServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('[]');
    });
    const arrayResolved = await resolveSecureCdpEndpoint(`http://127.0.0.1:${arrayPort}`);
    await expectCdpError(() => probeCdpVersion(arrayResolved), 'invalid_version_response');
  });

  it('fails on non-200 responses', async () => {
    const port = await startVersionServer((_request, response) => {
      response.writeHead(500);
      response.end('boom');
    });
    const resolved = await resolveSecureCdpEndpoint(`http://127.0.0.1:${port}`);
    await expectCdpError(() => probeCdpVersion(resolved), 'probe_failed');
  });

  it('times out against an unresponsive endpoint', async () => {
    const port = await startVersionServer(() => {
      // Accept the connection but never answer.
    });
    const resolved = await resolveSecureCdpEndpoint(`http://127.0.0.1:${port}`);
    await expectCdpError(() => probeCdpVersion(resolved, { timeoutMs: 250 }), 'timeout');
  });

  it('honours caller cancellation', async () => {
    const port = await jsonVersionServer();
    const resolved = await resolveSecureCdpEndpoint(`http://127.0.0.1:${port}`);
    await expectCdpError(
      () => probeCdpVersion(resolved, { signal: AbortSignal.abort() }),
      'aborted',
    );
  });

  it('pins the connection to the validated address after DNS rebinding', async () => {
    const port = await jsonVersionServer();
    let lookupCalls = 0;
    const rebindingLookup: LookupFn = async () => {
      lookupCalls += 1;
      // First answer is honest; every later answer is an attacker rebind.
      return lookupCalls === 1
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '203.0.113.9', family: 4 }];
    };

    const resolved = await resolveSecureCdpEndpoint(`http://rebind.test:${port}`, {
      lookup: rebindingLookup,
    });
    const version = await probeCdpVersion(resolved, { timeoutMs: 5000 });

    // The probe reached the pinned loopback server even though DNS now
    // returns a public address, and DNS was never consulted again.
    expect(version.protocolVersion).toBe('1.3');
    expect(lookupCalls).toBe(1);
  });
});

describe('probeCdpVersion: headers', () => {
  it('sends extra headers (e.g. Authorization) with the probe', async () => {
    let seenAuthorization: string | undefined;
    const port = await startVersionServer((request, response) => {
      seenAuthorization = request.headers.authorization;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ 'Protocol-Version': '1.3' }));
    });
    const resolved = await resolveSecureCdpEndpoint(`http://127.0.0.1:${port}`);
    await probeCdpVersion(resolved, {
      timeoutMs: 5000,
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(seenAuthorization).toBe('Bearer secret-token');
  });

  it('never lets a caller-supplied host header override the pinned host', async () => {
    let seenHost: string | undefined;
    const port = await startVersionServer((request, response) => {
      seenHost = request.headers.host;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ 'Protocol-Version': '1.3' }));
    });
    const resolved = await resolveSecureCdpEndpoint(`http://127.0.0.1:${port}`);
    await probeCdpVersion(resolved, {
      timeoutMs: 5000,
      headers: { Host: 'attacker.example', authorization: 'Bearer x' },
    });
    expect(seenHost).toBe(`127.0.0.1:${port}`);
  });
});

describe('fetchCdpWebSocketDebuggerUrl', () => {
  it('returns the raw debugger URL for in-process pinning', async () => {
    const port = await jsonVersionServer();
    const resolved = await resolveSecureCdpEndpoint(`http://127.0.0.1:${port}`);
    const url = await fetchCdpWebSocketDebuggerUrl(resolved, { timeoutMs: 5000 });
    expect(url).toBe(`ws://127.0.0.1:${port}/devtools/browser/${SECRET_ID}`);
  });

  it('returns undefined when the endpoint omits webSocketDebuggerUrl', async () => {
    const port = await startVersionServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ 'Protocol-Version': '1.3' }));
    });
    const resolved = await resolveSecureCdpEndpoint(`http://127.0.0.1:${port}`);
    const url = await fetchCdpWebSocketDebuggerUrl(resolved, { timeoutMs: 5000 });
    expect(url).toBeUndefined();
  });
});

describe('validateCdpEndpoint (one-shot)', () => {
  it('resolves and probes in a single call', async () => {
    const port = await jsonVersionServer();
    const { resolved, version } = await validateCdpEndpoint(`http://127.0.0.1:${port}`, {
      timeoutMs: 5000,
    });
    expect(resolved.host).toBe('127.0.0.1');
    expect(version.protocolVersion).toBe('1.3');
  });

  it('rejects a public URL before any probe', async () => {
    await expectCdpError(
      () => validateCdpEndpoint('http://example.com:9222'),
      'address_forbidden',
    );
  });
});

describe('redactDebuggerUrl', () => {
  it('keeps only scheme and host', () => {
    expect(redactDebuggerUrl('ws://127.0.0.1:9222/devtools/browser/abc-123')).toBe(
      'ws://127.0.0.1:9222/[REDACTED]',
    );
  });

  it('redacts unparseable values entirely', () => {
    expect(redactDebuggerUrl('not a url')).toBe('[REDACTED]');
  });
});

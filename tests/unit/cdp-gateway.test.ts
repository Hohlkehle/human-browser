import { describe, expect, it } from 'vitest';
import {
  CdpGatewayError,
  createCdpGateway,
  isAllowedHttpPath,
  isAllowedUpgradePath,
  isAddressAllowed,
  normalizePathname,
  normalizeRemoteAddress,
  redactPathnameForLog,
  rewriteDebuggerUrls,
  safePathname,
  verifyBearerToken,
} from '../../src/cdp/gateway.js';
import { type CidrRange, parseCidr } from '../../src/cdp/ip.js';

function cidrs(...entries: string[]): CidrRange[] {
  return entries
    .map((entry) => parseCidr(entry))
    .filter((range): range is CidrRange => range !== undefined);
}

describe('safePathname', () => {
  it('drops query strings and fragments', () => {
    expect(safePathname('/json/list?for_tab&secret=1')).toBe('/json/list');
    expect(safePathname('/json/version#frag')).toBe('/json/version');
  });

  it('normalizes dot segments so traversal cannot bypass the allowlist', () => {
    expect(safePathname('/devtools/../json/protocol')).toBe('/json/protocol');
    expect(safePathname('/devtools/./page/x')).toBe('/devtools/page/x');
  });

  it('tolerates malformed request targets', () => {
    expect(safePathname(undefined)).toBe('/');
  });
});

describe('redactPathnameForLog', () => {
  it('strips the secret target id from /devtools/* paths', () => {
    expect(redactPathnameForLog('/devtools/browser/abc-123')).toBe('/devtools/[REDACTED]');
    expect(redactPathnameForLog('/devtools/page/xyz-789')).toBe('/devtools/[REDACTED]');
    expect(redactPathnameForLog('/devtools/browser/secret/')).toBe('/devtools/[REDACTED]');
  });

  it('leaves non-devtools paths untouched', () => {
    expect(redactPathnameForLog('/json/version')).toBe('/json/version');
    expect(redactPathnameForLog('/healthz')).toBe('/healthz');
    expect(redactPathnameForLog('/')).toBe('/');
  });
});

describe('path allowlist', () => {
  it('allows exactly /json/version, /json/list, /json/new and /devtools/*', () => {
    expect(isAllowedHttpPath('/json/version')).toBe(true);
    expect(isAllowedHttpPath('/json/list')).toBe(true);
    expect(isAllowedHttpPath('/json/new')).toBe(true);
    expect(isAllowedHttpPath('/devtools/browser/abc')).toBe(true);
    expect(isAllowedHttpPath('/devtools/page/abc')).toBe(true);

    expect(isAllowedHttpPath('/json')).toBe(false);
    expect(isAllowedHttpPath('/json/protocol')).toBe(false);
    expect(isAllowedHttpPath('/devtools')).toBe(false);
    expect(isAllowedHttpPath('/')).toBe(false);
    expect(isAllowedHttpPath('/healthz')).toBe(false);
  });

  it('accepts trailing slashes (Playwright requests /json/version/)', () => {
    expect(normalizePathname('/json/version/')).toBe('/json/version');
    expect(isAllowedHttpPath('/json/version/')).toBe(true);
    expect(isAllowedHttpPath('/devtools/browser/abc/')).toBe(true);
  });

  it('restricts WebSocket upgrades to /devtools/*', () => {
    expect(isAllowedUpgradePath('/devtools/browser/abc')).toBe(true);
    expect(isAllowedUpgradePath('/json/version')).toBe(false);
    expect(isAllowedUpgradePath('/devtools')).toBe(false);
  });
});

describe('verifyBearerToken', () => {
  const token = 'test-token-value';

  it('accepts a correct bearer token', () => {
    expect(verifyBearerToken(`Bearer ${token}`, token)).toBe(true);
  });

  it('is case-insensitive on the scheme and tolerant of whitespace', () => {
    expect(verifyBearerToken(`bearer   ${token} `, token)).toBe(true);
  });

  it('rejects wrong tokens, other schemes, and missing headers', () => {
    expect(verifyBearerToken('Bearer wrong', token)).toBe(false);
    expect(verifyBearerToken(`Basic ${token}`, token)).toBe(false);
    expect(verifyBearerToken(token, token)).toBe(false);
    expect(verifyBearerToken(undefined, token)).toBe(false);
    expect(verifyBearerToken(`Bearer ${token}`, '')).toBe(false);
  });
});

describe('normalizeRemoteAddress', () => {
  it('parses plain IPv4 and IPv6', () => {
    expect(normalizeRemoteAddress('127.0.0.1')).toMatchObject({ version: 4 });
    expect(normalizeRemoteAddress('::1')).toMatchObject({ version: 6 });
  });

  it('folds IPv4-mapped IPv6 back to IPv4', () => {
    const mapped = normalizeRemoteAddress('::ffff:10.0.0.5');
    expect(mapped).toMatchObject({ version: 4 });
    expect(isAddressAllowed(mapped, cidrs('10.0.0.0/8'))).toBe(true);
  });

  it('strips IPv6 zone ids and rejects garbage', () => {
    expect(normalizeRemoteAddress('fe80::1%eth0')).toMatchObject({ version: 6 });
    expect(normalizeRemoteAddress('not-an-ip')).toBeUndefined();
    expect(normalizeRemoteAddress(undefined)).toBeUndefined();
  });
});

describe('isAddressAllowed', () => {
  it('matches only configured CIDRs', () => {
    const ranges = cidrs('127.0.0.1/32', '10.252.0.0/16');
    expect(isAddressAllowed(normalizeRemoteAddress('127.0.0.1'), ranges)).toBe(true);
    expect(isAddressAllowed(normalizeRemoteAddress('10.252.7.9'), ranges)).toBe(true);
    expect(isAddressAllowed(normalizeRemoteAddress('8.8.8.8'), ranges)).toBe(false);
    expect(isAddressAllowed(undefined, ranges)).toBe(false);
  });
});

describe('rewriteDebuggerUrls', () => {
  it('rewrites webSocketDebuggerUrl to the client-facing host at any depth', () => {
    const input = {
      'Protocol-Version': '1.3',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
      nested: [{ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/p1' }],
    };
    const rewritten = rewriteDebuggerUrls(input, '10.252.150.2:9229') as typeof input;
    expect(rewritten.webSocketDebuggerUrl).toBe('ws://10.252.150.2:9229/devtools/browser/abc');
    expect(rewritten.nested[0]?.webSocketDebuggerUrl).toBe(
      'ws://10.252.150.2:9229/devtools/page/p1',
    );
    expect(rewritten['Protocol-Version']).toBe('1.3');
  });

  it('leaves non-URL values untouched', () => {
    const input = { webSocketDebuggerUrl: 'not a url' };
    expect(rewriteDebuggerUrls(input, 'h:1')).toEqual(input);
  });
});

describe('createCdpGateway startup refusal', () => {
  const base = {
    listenHost: '127.0.0.1',
    listenPort: 0,
    target: 'http://127.0.0.1:9222',
    allowedCidrs: ['127.0.0.1/32'],
  };

  it('refuses to start without a bearer token', async () => {
    await expect(createCdpGateway({ ...base, bearerToken: '' })).rejects.toThrow(
      /bearer token/i,
    );
  });

  it('refuses to start without allowedCidrs', async () => {
    await expect(
      createCdpGateway({ ...base, bearerToken: 'token', allowedCidrs: [] }),
    ).rejects.toThrow(/allowedCidrs/);
  });

  it('refuses to start with an invalid CIDR', async () => {
    await expect(
      createCdpGateway({ ...base, bearerToken: 'token', allowedCidrs: ['nope'] }),
    ).rejects.toThrow(CdpGatewayError);
  });

  it('refuses to start when the target address is forbidden', async () => {
    await expect(
      createCdpGateway({
        ...base,
        bearerToken: 'token',
        target: 'http://8.8.8.8:9222',
      }),
    ).rejects.toThrow(/not an allowed CDP endpoint/);
  });
});

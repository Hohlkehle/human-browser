import { describe, expect, it } from 'vitest';
import {
  classifyIp,
  formatIp,
  ipInCidr,
  isDefaultAllowed,
  parseCidr,
  parseIp,
} from '../../src/cdp/ip.js';

function classify(address: string): string {
  const ip = parseIp(address);
  if (!ip) throw new Error(`unparseable ${address}`);
  return classifyIp(ip);
}

describe('parseIp', () => {
  it('parses IPv4 literals', () => {
    const ip = parseIp('192.168.1.10');
    expect(ip).toBeDefined();
    expect(ip?.version).toBe(4);
    expect(Array.from(ip?.bytes ?? [])).toEqual([192, 168, 1, 10]);
  });

  it('parses IPv6 literals including compressed form', () => {
    const ip = parseIp('2001:db8::1');
    expect(ip).toBeDefined();
    expect(ip?.version).toBe(6);
    expect(ip?.bytes.length).toBe(16);
    expect(ip?.bytes[0]).toBe(0x20);
    expect(ip?.bytes[1]).toBe(0x01);
    expect(ip?.bytes[15]).toBe(1);
  });

  it('parses IPv4-mapped IPv6 literals', () => {
    const ip = parseIp('::ffff:127.0.0.1');
    expect(ip?.version).toBe(6);
    expect(ip?.bytes[10]).toBe(0xff);
    expect(ip?.bytes[11]).toBe(0xff);
    expect(Array.from(ip?.bytes.slice(12) ?? [])).toEqual([127, 0, 0, 1]);
  });

  it('rejects garbage', () => {
    expect(parseIp('')).toBeUndefined();
    expect(parseIp('not-an-ip')).toBeUndefined();
    expect(parseIp('256.1.1.1')).toBeUndefined();
    expect(parseIp('1.2.3')).toBeUndefined();
    expect(parseIp('1:2:3:4:5:6:7:8:9')).toBeUndefined();
    expect(parseIp('fe80::1%eth0')).toBeUndefined();
  });
});

describe('classifyIp', () => {
  it('classifies IPv4 ranges', () => {
    expect(classify('127.0.0.1')).toBe('loopback');
    expect(classify('127.255.0.9')).toBe('loopback');
    expect(classify('10.252.150.2')).toBe('private');
    expect(classify('172.16.0.1')).toBe('private');
    expect(classify('172.31.255.255')).toBe('private');
    expect(classify('192.168.0.1')).toBe('private');
    expect(classify('172.32.0.1')).toBe('public');
    expect(classify('169.254.10.10')).toBe('linkLocal');
    expect(classify('224.0.0.1')).toBe('multicast');
    expect(classify('239.255.255.255')).toBe('multicast');
    expect(classify('255.255.255.255')).toBe('broadcast');
    expect(classify('0.0.0.1')).toBe('unspecified');
    expect(classify('8.8.8.8')).toBe('public');
    expect(classify('93.184.216.34')).toBe('public');
    expect(classify('100.64.0.1')).toBe('public'); // CGNAT is not trusted
  });

  it('classifies IPv6 ranges', () => {
    expect(classify('::1')).toBe('loopback');
    expect(classify('::')).toBe('unspecified');
    expect(classify('fe80::1')).toBe('linkLocal');
    expect(classify('fc00::1')).toBe('private');
    expect(classify('fdff:ffff::1')).toBe('private');
    expect(classify('ff02::1')).toBe('multicast');
    expect(classify('2001:4860:4860::8888')).toBe('public');
    expect(classify('2001:db8::1')).toBe('public'); // documentation space
    expect(classify('2002::1')).toBe('public'); // 6to4 tunnel
  });

  it('classifies IPv4-mapped IPv6 by the embedded IPv4 address', () => {
    expect(classify('::ffff:127.0.0.1')).toBe('loopback');
    expect(classify('::ffff:10.0.0.5')).toBe('private');
    expect(classify('::ffff:8.8.8.8')).toBe('public');
    expect(classify('::ffff:169.254.1.1')).toBe('linkLocal');
  });
});

describe('isDefaultAllowed', () => {
  it('allows only loopback and private by default', () => {
    expect(isDefaultAllowed('loopback')).toBe(true);
    expect(isDefaultAllowed('private')).toBe(true);
    expect(isDefaultAllowed('linkLocal')).toBe(false);
    expect(isDefaultAllowed('multicast')).toBe(false);
    expect(isDefaultAllowed('broadcast')).toBe(false);
    expect(isDefaultAllowed('unspecified')).toBe(false);
    expect(isDefaultAllowed('public')).toBe(false);
  });
});

describe('parseCidr / ipInCidr', () => {
  it('matches IPv4 CIDRs', () => {
    const range = parseCidr('10.252.0.0/16');
    expect(range).toBeDefined();
    const inside = parseIp('10.252.150.2');
    const outside = parseIp('10.253.0.1');
    expect(inside && range && ipInCidr(inside, range)).toBe(true);
    expect(outside && range && ipInCidr(outside, range)).toBe(false);
  });

  it('matches IPv6 CIDRs', () => {
    const range = parseCidr('fc00::/7');
    const inside = parseIp('fd12:3456::1');
    const outside = parseIp('2001:db8::1');
    expect(inside && range && ipInCidr(inside, range)).toBe(true);
    expect(outside && range && ipInCidr(outside, range)).toBe(false);
  });

  it('treats a bare IP as an exact match', () => {
    const range = parseCidr('203.0.113.7');
    expect(range?.prefix).toBe(32);
    const exact = parseIp('203.0.113.7');
    const neighbor = parseIp('203.0.113.8');
    expect(exact && range && ipInCidr(exact, range)).toBe(true);
    expect(neighbor && range && ipInCidr(neighbor, range)).toBe(false);
  });

  it('handles boundary prefixes', () => {
    const all = parseCidr('0.0.0.0/0');
    const anyIp = parseIp('203.0.113.9');
    expect(anyIp && all && ipInCidr(anyIp, all)).toBe(true);

    const exactV6 = parseCidr('::1/128');
    const loopback = parseIp('::1');
    const other = parseIp('::2');
    expect(loopback && exactV6 && ipInCidr(loopback, exactV6)).toBe(true);
    expect(other && exactV6 && ipInCidr(other, exactV6)).toBe(false);
  });

  it('never matches across IP versions', () => {
    const v4Range = parseCidr('127.0.0.1/8');
    const v6 = parseIp('::1');
    expect(v6 && v4Range && ipInCidr(v6, v4Range)).toBe(false);
  });

  it('rejects invalid CIDRs', () => {
    expect(parseCidr('')).toBeUndefined();
    expect(parseCidr('nonsense')).toBeUndefined();
    expect(parseCidr('10.0.0.0/33')).toBeUndefined();
    expect(parseCidr('::1/129')).toBeUndefined();
    expect(parseCidr('10.0.0.0/-1')).toBeUndefined();
    expect(parseCidr('10.0.0.0/abc')).toBeUndefined();
  });
});

describe('formatIp', () => {
  it('round-trips addresses', () => {
    const v4 = parseIp('10.252.150.2');
    expect(v4 && formatIp(v4)).toBe('10.252.150.2');
    const v6 = parseIp('2001:db8::1');
    expect(v6 && formatIp(v6)).toBe('2001:db8:0:0:0:0:0:1');
  });
});

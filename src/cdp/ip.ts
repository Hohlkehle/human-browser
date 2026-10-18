import { isIPv4, isIPv6 } from 'node:net';

export type IpVersion = 4 | 6;

/**
 * Security classification of a resolved IP address. Everything except
 * `loopback` and `private` is denied by default and can only be allowed
 * through an explicit administrator CIDR allowlist.
 */
export type IpClass =
  | 'loopback'
  | 'private'
  | 'linkLocal'
  | 'multicast'
  | 'broadcast'
  | 'unspecified'
  | 'public';

export interface ParsedIp {
  readonly bytes: Uint8Array;
  readonly version: IpVersion;
}

export interface CidrRange {
  readonly network: Uint8Array;
  readonly prefix: number;
  readonly version: IpVersion;
}

export function parseIp(input: string): ParsedIp | undefined {
  if (isIPv4(input)) {
    const bytes = parseIpv4Bytes(input);
    return bytes ? { bytes, version: 4 } : undefined;
  }
  if (isIPv6(input)) {
    const bytes = parseIpv6Bytes(input);
    return bytes ? { bytes, version: 6 } : undefined;
  }
  return undefined;
}

function parseIpv4Bytes(input: string): Uint8Array | undefined {
  const parts = input.split('.');
  if (parts.length !== 4) return undefined;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    const value = Number.parseInt(parts[i] as string, 10);
    if (!Number.isInteger(value) || value < 0 || value > 255) return undefined;
    bytes[i] = value;
  }
  return bytes;
}

function parseIpv6Bytes(input: string): Uint8Array | undefined {
  let address = input;

  // Expand an embedded trailing IPv4 literal (e.g. ::ffff:127.0.0.1) into two
  // hex groups so the rest of the parser only deals with colon-hex form.
  const v4Tail = address.match(/^(.*[:.])(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Tail) {
    const v4 = parseIpv4Bytes(v4Tail[2] as string);
    if (!v4) return undefined;
    const hi = ((v4[0] as number) << 8) | (v4[1] as number);
    const lo = ((v4[2] as number) << 8) | (v4[3] as number);
    address = `${v4Tail[1]}${hi.toString(16)}:${lo.toString(16)}`;
  }

  const doubleColonParts = address.split('::');
  if (doubleColonParts.length > 2) return undefined;

  const parseGroups = (side: string): number[] | undefined => {
    if (side === '') return [];
    const groups: number[] = [];
    for (const piece of side.split(':')) {
      if (piece.length === 0 || piece.length > 4 || !/^[0-9a-fA-F]+$/.test(piece)) {
        return undefined;
      }
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };

  const head = parseGroups(doubleColonParts[0] as string);
  const tail = doubleColonParts.length === 2 ? parseGroups(doubleColonParts[1] as string) : [];
  if (!head || !tail) return undefined;

  let groups: number[];
  if (doubleColonParts.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return undefined;
    groups = [...head, ...Array.from({ length: missing }, () => 0), ...tail];
  } else {
    if (head.length !== 8) return undefined;
    groups = head;
  }

  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = (group >> 8) & 0xff;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function classifyIpv4(bytes: Uint8Array): IpClass {
  const first = bytes[0] as number;
  const second = bytes[1] as number;

  if (first === 0) return 'unspecified'; // "this" network, 0.0.0.0/8
  if (first === 127) return 'loopback';
  if (first === 10) return 'private'; // RFC1918
  if (first === 172 && second >= 16 && second <= 31) return 'private'; // RFC1918
  if (first === 192 && second === 168) return 'private'; // RFC1918
  if (first === 169 && second === 254) return 'linkLocal';
  if (first >= 224 && first <= 239) return 'multicast';
  if (first === 255 && second === 255 && bytes[2] === 255 && bytes[3] === 255) return 'broadcast';
  return 'public'; // includes CGNAT 100.64.0.0/10 on purpose
}

function classifyIpv6(bytes: Uint8Array): IpClass {
  const allZero = bytes.every((value) => value === 0);
  if (allZero) return 'unspecified'; // ::/128

  // ::1/128
  if (bytes[15] === 1 && Array.from(bytes.slice(0, 15)).every((value) => value === 0)) {
    return 'loopback';
  }

  // IPv4-mapped (::ffff:a.b.c.d/96) and IPv4-compatible (::a.b.c.d/96,
  // deprecated) addresses are classified by their embedded IPv4 address so a
  // mapped public address cannot sneak past the IPv4 policy.
  const leadingZeros = Array.from(bytes.slice(0, 10)).every((value) => value === 0);
  if (leadingZeros) {
    const isMapped = bytes[10] === 0xff && bytes[11] === 0xff;
    const isCompatible = bytes[10] === 0 && bytes[11] === 0;
    if (isMapped || isCompatible) return classifyIpv4(bytes.slice(12, 16));
  }

  const first = bytes[0] as number;
  if ((first & 0xfe) === 0xfc) return 'private'; // fc00::/7 unique-local
  if (first === 0xfe && ((bytes[1] as number) & 0xc0) === 0x80) return 'linkLocal'; // fe80::/10
  if (first === 0xff) return 'multicast'; // ff00::/8
  return 'public'; // global, 2001:db8::/32 docs, 6to4, Teredo, everything else
}

export function classifyIp(ip: ParsedIp): IpClass {
  return ip.version === 4 ? classifyIpv4(ip.bytes) : classifyIpv6(ip.bytes);
}

/** Classes allowed by default: loopback and RFC1918-style private space. */
export function isDefaultAllowed(ipClass: IpClass): boolean {
  return ipClass === 'loopback' || ipClass === 'private';
}

export function parseCidr(input: string): CidrRange | undefined {
  const trimmed = input.trim();
  const slash = trimmed.indexOf('/');
  const addressPart = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const ip = parseIp(addressPart);
  if (!ip) return undefined;

  const maxPrefix = ip.version === 4 ? 32 : 128;
  let prefix: number;
  if (slash === -1) {
    prefix = maxPrefix; // bare IP means an exact /32 or /128 match
  } else {
    const prefixPart = trimmed.slice(slash + 1);
    if (!/^\d+$/.test(prefixPart)) return undefined;
    prefix = Number.parseInt(prefixPart, 10);
    if (prefix < 0 || prefix > maxPrefix) return undefined;
  }

  return { network: ip.bytes, prefix, version: ip.version };
}

export function ipInCidr(ip: ParsedIp, range: CidrRange): boolean {
  if (ip.version !== range.version) return false;

  const fullBytes = Math.floor(range.prefix / 8);
  for (let i = 0; i < fullBytes; i += 1) {
    if (ip.bytes[i] !== range.network[i]) return false;
  }

  const remainingBits = range.prefix % 8;
  if (remainingBits > 0) {
    const mask = (0xff << (8 - remainingBits)) & 0xff;
    if (((ip.bytes[fullBytes] as number) & mask) !== ((range.network[fullBytes] as number) & mask)) {
      return false;
    }
  }
  return true;
}

export function formatIp(ip: ParsedIp): string {
  if (ip.version === 4) return Array.from(ip.bytes).join('.');
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push((((ip.bytes[i] as number) << 8) | (ip.bytes[i + 1] as number)).toString(16));
  }
  return groups.join(':');
}

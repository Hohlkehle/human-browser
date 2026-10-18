/**
 * Domain allowlist policy (Stage 5).
 *
 * Navigation initiated by the MCP server (`page_navigate`, `page_open` with a
 * URL) must target a hostname from the configured allowlist. The check runs
 * BEFORE anything reaches the browser adapter, so a forbidden destination is
 * rejected without any network activity.
 *
 * Matching rules:
 * - Entries are exact hostnames, compared case-insensitively and without
 *   ports. Listing `example.com` does NOT allow `sub.example.com`; list every
 *   hostname that should be reachable (this is why the default configuration
 *   lists the `www.` variants explicitly).
 * - An entry may be a wildcard of the form `*.example.com`, which matches any
 *   single or nested subdomain (`a.example.com`, `a.b.example.com`) but never
 *   the bare `example.com` itself.
 * - The single entry `*` is an explicit opt-in to allow ANY http/https host
 *   (local personal use). Scheme and credential checks still apply. The
 *   server logs a warning at startup when it is configured.
 * - Only `http:`/`https:` URLs are allowed; `about:blank` is allowed because
 *   it performs no network request. URLs with embedded credentials are
 *   rejected.
 *
 * The adapter (Stage 4) independently re-validates scheme and credentials;
 * this module is the domain layer on top of it.
 */

export type DomainPolicyErrorCode = 'invalid_policy' | 'invalid_argument' | 'domain_forbidden';

export class DomainPolicyError extends Error {
  readonly code: DomainPolicyErrorCode;

  constructor(code: DomainPolicyErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DomainPolicyError';
    this.code = code;
  }
}

interface PolicyEntry {
  /** Normalized hostname (lowercase, no leading dot) or wildcard suffix. */
  readonly value: string;
  readonly wildcard: boolean;
  /** The single `*` entry: any http/https host is allowed (explicit opt-in). */
  readonly matchAll?: boolean;
}

export interface DomainPolicy {
  /** The normalized allowlist entries, in configuration order. */
  readonly allowedDomains: readonly string[];
  /** True when the URL parses and its hostname is on the allowlist. */
  isUrlAllowed(url: string): boolean;
  /** Throws `DomainPolicyError` when the URL must not be navigated to. */
  assertNavigableUrl(url: string): void;
}

function normalizeEntry(raw: string): PolicyEntry {
  const entry = raw.trim().toLowerCase();
  // The single `*` entry is an explicit opt-in to allow ANY http/https host
  // (local personal use). Scheme and credential checks still apply.
  if (entry === '*') {
    return { value: '*', wildcard: false, matchAll: true };
  }
  if (entry.startsWith('*.')) {
    const suffix = entry.slice(2).replace(/\.+$/, '');
    if (suffix === '' || suffix.includes('*')) {
      throw new DomainPolicyError(
        'invalid_policy',
        `Invalid wildcard domain entry "${raw}"; expected "*.example.com"`,
      );
    }
    return { value: suffix, wildcard: true };
  }
  // IPv6 literals may be configured with or without URL brackets.
  const host = entry.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (host === '' || host.includes('*') || host.includes('/')) {
    throw new DomainPolicyError(
      'invalid_policy',
      `Invalid domain entry "${raw}"; expected a hostname like "example.com"`,
    );
  }
  return { value: host, wildcard: false };
}

function hostnameMatches(hostname: string, entries: readonly PolicyEntry[]): boolean {
  // WHATWG URLs keep IPv6 literals bracketed (`[::1]`); entries never are.
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
  if (host === '') return false;
  for (const entry of entries) {
    if (entry.matchAll) {
      return true;
    }
    if (entry.wildcard) {
      // `*.example.com` matches `<anything>.example.com`, never bare domain.
      if (host.length > entry.value.length + 1 && host.endsWith(`.${entry.value}`)) return true;
    } else if (host === entry.value) {
      return true;
    }
  }
  return false;
}

/**
 * Creates a domain policy. When the allowlist is empty, all http/https
 * URLs are allowed (no domain restrictions). Scheme and credential checks
 * still apply.
 */
export function createDomainPolicy(allowedDomains: readonly string[]): DomainPolicy {
  if (!Array.isArray(allowedDomains)) {
    throw new DomainPolicyError('invalid_policy', 'allowedDomains must be an array');
  }
  const entries = allowedDomains.map((raw) => {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new DomainPolicyError(
        'invalid_policy',
        'allowedDomains entries must be non-empty strings',
      );
    }
    return normalizeEntry(raw);
  });
  const normalized = entries.map((entry) => (entry.wildcard ? `*.${entry.value}` : entry.value));

  function isUrlAllowed(url: string): boolean {
    if (url === 'about:blank') return true;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username !== '' || parsed.password !== '') return false;
    if (entries.length === 0) return true;
    return hostnameMatches(parsed.hostname, entries);
  }

  function assertNavigableUrl(url: string): void {
    if (url === 'about:blank') return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new DomainPolicyError('invalid_argument', 'url is not a valid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new DomainPolicyError(
        'invalid_argument',
        `Navigation scheme "${parsed.protocol}" is not allowed; use http/https`,
      );
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new DomainPolicyError(
        'invalid_argument',
        'Navigation URL must not contain credentials',
      );
    }
    if (entries.length > 0 && !hostnameMatches(parsed.hostname, entries)) {
      throw new DomainPolicyError(
        'domain_forbidden',
        `Host "${parsed.hostname}" is not on the domain allowlist (${normalized.join(', ')})`,
      );
    }
  }

  return { allowedDomains: normalized, isUrlAllowed, assertNavigableUrl };
}

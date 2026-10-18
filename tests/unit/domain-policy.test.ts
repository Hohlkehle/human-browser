/**
 * Stage 5 unit tests: domain allowlist policy.
 */
import { describe, expect, it } from 'vitest';
import { createDomainPolicy, DomainPolicyError } from '../../src/policy/domains.js';

const DEFAULT_ALLOWLIST = [
  'partslink24.com',
  'www.partslink24.com',
  'partsouq.com',
  'www.partsouq.com',
];

describe('createDomainPolicy', () => {
  it('allows all domains when the allowlist is empty', () => {
    const policy = createDomainPolicy([]);
    expect(policy.allowedDomains).toEqual([]);
    expect(() => policy.assertNavigableUrl('https://example.com/')).not.toThrow();
    expect(() => policy.assertNavigableUrl('https://any-host.example.org/')).not.toThrow();
    expect(policy.isUrlAllowed('https://random.io/')).toBe(true);
  });

  it('rejects blank or malformed entries', () => {
    expect(() => createDomainPolicy([''])).toThrow('non-empty');
    expect(() => createDomainPolicy(['example.com/path'])).toThrow(DomainPolicyError);
    expect(() => createDomainPolicy(['*.'])).toThrow(DomainPolicyError);
    expect(() => createDomainPolicy(['*.*.com'])).toThrow(DomainPolicyError);
  });

  it('normalizes entries (lowercase, trailing dots stripped)', () => {
    const policy = createDomainPolicy(['  Example.COM.  ']);
    expect(policy.allowedDomains).toEqual(['example.com']);
    expect(policy.isUrlAllowed('https://EXAMPLE.com/x')).toBe(true);
  });
});

describe('assertNavigableUrl', () => {
  const policy = createDomainPolicy(DEFAULT_ALLOWLIST);

  it('allows allowlisted hosts with any path, query or port', () => {
    expect(() => policy.assertNavigableUrl('https://partslink24.com/')).not.toThrow();
    expect(() =>
      policy.assertNavigableUrl('https://www.partslink24.com/search?q=brake&x=1'),
    ).not.toThrow();
    expect(() => policy.assertNavigableUrl('http://partsouq.com:8080/deep/path')).not.toThrow();
  });

  it('allows about:blank', () => {
    expect(() => policy.assertNavigableUrl('about:blank')).not.toThrow();
    expect(policy.isUrlAllowed('about:blank')).toBe(true);
  });

  it('blocks hosts that are not on the allowlist', () => {
    expect(() => policy.assertNavigableUrl('https://example.com/')).toThrowError(DomainPolicyError);
    try {
      policy.assertNavigableUrl('https://evil.com/');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainPolicyError);
      expect((error as DomainPolicyError).code).toBe('domain_forbidden');
    }
  });

  it('does NOT allow subdomains of a bare-domain entry', () => {
    expect(() => policy.assertNavigableUrl('https://sub.partslink24.com/')).toThrow(
      /domain allowlist/,
    );
    expect(policy.isUrlAllowed('https://phishing.partsouq.com/')).toBe(false);
  });

  it('rejects lookalike suffix hosts', () => {
    expect(() => policy.assertNavigableUrl('https://notpartslink24.com/')).toThrow(
      /domain allowlist/,
    );
    expect(() => policy.assertNavigableUrl('https://partslink24.com.evil.com/')).toThrow(
      /domain allowlist/,
    );
  });

  it('rejects non-http(s) schemes', () => {
    for (const url of ['file:///c:/windows', 'javascript:alert(1)', 'ftp://partslink24.com/x']) {
      try {
        policy.assertNavigableUrl(url);
        expect.unreachable();
      } catch (error) {
        expect((error as DomainPolicyError).code).toBe('invalid_argument');
      }
    }
  });

  it('rejects URLs with embedded credentials', () => {
    try {
      policy.assertNavigableUrl('https://user:pass@partslink24.com/');
      expect.unreachable();
    } catch (error) {
      expect((error as DomainPolicyError).code).toBe('invalid_argument');
    }
  });

  it('rejects invalid URLs', () => {
    try {
      policy.assertNavigableUrl('not a url');
      expect.unreachable();
    } catch (error) {
      expect((error as DomainPolicyError).code).toBe('invalid_argument');
    }
  });

  it('supports wildcard entries for subdomains only', () => {
    const wildcard = createDomainPolicy(['*.example.com']);
    expect(() => wildcard.assertNavigableUrl('https://a.example.com/')).not.toThrow();
    expect(() => wildcard.assertNavigableUrl('https://a.b.example.com/')).not.toThrow();
    // The bare domain itself is not covered by `*.example.com`.
    expect(() => wildcard.assertNavigableUrl('https://example.com/')).toThrow(/domain allowlist/);
    expect(() => wildcard.assertNavigableUrl('https://badexample.com/')).toThrow(
      /domain allowlist/,
    );
  });

  it('supports the single "*" entry as an explicit allow-any-host opt-in', () => {
    const any = createDomainPolicy(['*']);
    expect(any.allowedDomains).toEqual(['*']);
    expect(() => any.assertNavigableUrl('https://example.com/')).not.toThrow();
    expect(() => any.assertNavigableUrl('http://anything.elsewhere.org/deep/path')).not.toThrow();
    expect(() => any.assertNavigableUrl('about:blank')).not.toThrow();
    expect(any.isUrlAllowed('https://random.io/')).toBe(true);
  });

  it('"*" still enforces scheme and credential rules', () => {
    const any = createDomainPolicy(['*']);
    for (const url of ['file:///c:/windows', 'javascript:alert(1)', 'ftp://example.com/x']) {
      try {
        any.assertNavigableUrl(url);
        expect.unreachable();
      } catch (error) {
        expect((error as DomainPolicyError).code).toBe('invalid_argument');
      }
    }
    try {
      any.assertNavigableUrl('https://user:pass@example.com/');
      expect.unreachable();
    } catch (error) {
      expect((error as DomainPolicyError).code).toBe('invalid_argument');
    }
    expect(any.isUrlAllowed('file:///c:/windows')).toBe(false);
  });

  it('still rejects other bare-asterisk forms', () => {
    expect(() => createDomainPolicy(['*.*.com'])).toThrow(DomainPolicyError);
    expect(() => createDomainPolicy(['example.*'])).toThrow(DomainPolicyError);
    expect(() => createDomainPolicy(['**.com'])).toThrow(DomainPolicyError);
  });

  it('matches IPv6 literals exactly (brackets optional in config)', () => {
    const v6 = createDomainPolicy(['::1']);
    expect(() => v6.assertNavigableUrl('http://[::1]:9222/')).not.toThrow();
    expect(() => v6.assertNavigableUrl('http://[::2]:9222/')).toThrow(/domain allowlist/);

    const bracketed = createDomainPolicy(['[::1]']);
    expect(() => bracketed.assertNavigableUrl('http://[::1]:9222/')).not.toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import {
  deriveAdapterHeaders,
  loadConfig,
  validateStartupSecurity,
} from '../../src/config/schema.js';

describe('configuration', () => {
  it('loads safe local defaults', () => {
    const config = loadConfig({});

    expect(config.cdp.endpoint).toBe('http://127.0.0.1:9222');
    expect(config.mcp.listenHost).toBe('127.0.0.1');
    expect(config.browser.visibleModeRequired).toBe(true);
  });

  it('rejects invalid ports', () => {
    expect(() => loadConfig({ MCP_LISTEN_PORT: '70000' })).toThrow();
  });

  it('requires token and CIDRs for a public gateway bind', () => {
    const environment = {
      GATEWAY_LISTEN_HOST: '0.0.0.0',
      GATEWAY_ALLOWED_CIDRS: '10.252.0.0/16',
    };
    const config = loadConfig(environment);

    expect(() => validateStartupSecurity(config, environment)).toThrow(/CDP_GATEWAY_TOKEN/);
  });

  it('requires a token for any enabled gateway, including loopback binds', () => {
    const config = loadConfig({ GATEWAY_LISTEN_HOST: '127.0.0.1' });
    expect(() => validateStartupSecurity(config, {})).toThrow(/CDP_GATEWAY_TOKEN/);
  });

  it('accepts an enabled gateway with token and CIDRs', () => {
    const environment = { CDP_GATEWAY_TOKEN: 'secret-value' };
    const config = loadConfig(environment);
    expect(() => validateStartupSecurity(config, environment)).not.toThrow();
  });

  it('skips gateway secret checks when the gateway is disabled', () => {
    const config = loadConfig({ GATEWAY_ENABLED: 'false' });
    expect(() => validateStartupSecurity(config, {})).not.toThrow();
  });

  it('loads gateway rate limit settings with safe defaults', () => {
    const defaults = loadConfig({});
    expect(defaults.gateway.rateLimitWindowMs).toBe(60_000);
    expect(defaults.gateway.rateLimitMax).toBe(120);

    const custom = loadConfig({
      GATEWAY_RATE_LIMIT_WINDOW_MS: '1000',
      GATEWAY_RATE_LIMIT_MAX: '5',
    });
    expect(custom.gateway.rateLimitWindowMs).toBe(1_000);
    expect(custom.gateway.rateLimitMax).toBe(5);

    expect(() => loadConfig({ GATEWAY_RATE_LIMIT_MAX: '0' })).toThrow();
  });

  it('accepts the allowed CDP endpoint forms', () => {
    expect(loadConfig({ CDP_ENDPOINT: 'http://127.0.0.1:9222' }).cdp.endpoint).toBe(
      'http://127.0.0.1:9222',
    );
    expect(loadConfig({ CDP_ENDPOINT: 'http://10.252.150.2:9229' }).cdp.endpoint).toBe(
      'http://10.252.150.2:9229',
    );
    expect(loadConfig({ CDP_ENDPOINT: 'ws://127.0.0.1:9222' }).cdp.endpoint).toBe(
      'ws://127.0.0.1:9222',
    );
  });

  it('rejects CDP endpoints with a forbidden scheme', () => {
    expect(() => loadConfig({ CDP_ENDPOINT: 'ftp://127.0.0.1:9222' })).toThrow(/scheme/);
  });

  it('rejects CDP endpoints containing credentials', () => {
    expect(() => loadConfig({ CDP_ENDPOINT: 'http://user:pass@127.0.0.1:9222' })).toThrow(
      /credentials/,
    );
  });

  it('rejects malformed CIDR allowlists', () => {
    expect(() => loadConfig({ CDP_ALLOWED_CIDRS: 'not-a-cidr' })).toThrow(/CIDR/);
    expect(() => loadConfig({ GATEWAY_ALLOWED_CIDRS: '10.0.0.0/33' })).toThrow(/CIDR/);
  });
});

describe('deriveAdapterHeaders', () => {
  it('returns the gateway bearer when the CDP endpoint targets the enabled gateway', () => {
    const environment = {
      CDP_ENDPOINT: 'http://127.0.0.1:9229',
      CDP_GATEWAY_TOKEN: 'secret-token',
    };
    const config = loadConfig(environment);
    expect(deriveAdapterHeaders(config, environment)).toEqual({
      Authorization: 'Bearer secret-token',
    });
  });

  it('returns nothing for a direct Chrome endpoint', () => {
    const environment = {
      CDP_ENDPOINT: 'http://127.0.0.1:9222',
      CDP_GATEWAY_TOKEN: 'secret-token',
    };
    const config = loadConfig(environment);
    expect(deriveAdapterHeaders(config, environment)).toBeUndefined();
  });

  it('returns nothing when the gateway is disabled', () => {
    const environment = {
      GATEWAY_ENABLED: 'false',
      CDP_ENDPOINT: 'http://127.0.0.1:9229',
      CDP_GATEWAY_TOKEN: 'secret-token',
    };
    const config = loadConfig(environment);
    expect(deriveAdapterHeaders(config, environment)).toBeUndefined();
  });

  it('matches a wildcard gateway bind on port only', () => {
    const environment = {
      GATEWAY_LISTEN_HOST: '0.0.0.0',
      GATEWAY_ALLOWED_CIDRS: '10.0.0.0/8',
      CDP_ENDPOINT: 'http://10.252.150.2:9229',
      CDP_GATEWAY_TOKEN: 'secret-token',
    };
    const config = loadConfig(environment);
    expect(deriveAdapterHeaders(config, environment)).toEqual({
      Authorization: 'Bearer secret-token',
    });
  });

  it('never sends the token to a different host on the gateway port', () => {
    const environment = {
      CDP_ENDPOINT: 'http://10.252.150.2:9229',
      CDP_GATEWAY_TOKEN: 'secret-token',
    };
    const config = loadConfig(environment);
    expect(deriveAdapterHeaders(config, environment)).toBeUndefined();
  });

  it('returns nothing without the secret', () => {
    const environment = { CDP_ENDPOINT: 'http://127.0.0.1:9229' };
    const config = loadConfig(environment);
    expect(deriveAdapterHeaders(config, environment)).toBeUndefined();
  });
});

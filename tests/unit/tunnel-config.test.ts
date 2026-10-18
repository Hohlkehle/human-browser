/**
 * Stage 7 unit tests: tunnel-client configuration. The tunnel token is an
 * env-only secret — these tests assert it never becomes part of the config.
 */
import { describe, expect, it } from 'vitest';
import {
  describeConfigError,
  loadTunnelConfig,
  tunnelToken,
  TUNNEL_TOKEN_ENV,
} from '../../src/tunnel/config.js';

describe('loadTunnelConfig', () => {
  it('applies secure defaults: loopback MCP origin, named mode, PATH cloudflared', () => {
    const config = loadTunnelConfig({});
    expect(config.target).toBe('http://127.0.0.1:9230');
    expect(config.mode).toBe('named');
    expect(config.cloudflaredBin).toBe('cloudflared');
    expect(config.publicUrl).toBeUndefined();
  });

  it('accepts overrides incl. ::1 target and a public URL', () => {
    const config = loadTunnelConfig({
      TUNNEL_TARGET: 'http://[::1]:9231',
      TUNNEL_MODE: 'quick',
      TUNNEL_CLOUDFLARED_BIN: 'C:\\bin\\cloudflared.exe',
      TUNNEL_PUBLIC_URL: 'https://browser-mcp.example.com',
    });
    expect(config.target).toBe('http://[::1]:9231');
    expect(config.mode).toBe('quick');
    expect(config.cloudflaredBin).toBe('C:\\bin\\cloudflared.exe');
    expect(config.publicUrl).toBe('https://browser-mcp.example.com');
  });

  it('rejects non-loopback targets (the tunnel only forwards to the local MCP)', () => {
    for (const target of [
      'http://10.0.0.5:9230',
      'http://192.168.1.2:9230',
      'http://example.com:9230',
      'http://0.0.0.0:9230',
      'http://localhost:9230',
    ]) {
      expect(() => loadTunnelConfig({ TUNNEL_TARGET: target })).toThrow(/loopback/);
    }
  });

  it('rejects non-http schemes, credentials, and paths', () => {
    expect(() => loadTunnelConfig({ TUNNEL_TARGET: 'https://127.0.0.1:9230' })).toThrow(/scheme/);
    expect(() => loadTunnelConfig({ TUNNEL_TARGET: 'ws://127.0.0.1:9222' })).toThrow(/scheme/);
    expect(() => loadTunnelConfig({ TUNNEL_TARGET: 'http://user:pass@127.0.0.1:9230' })).toThrow(
      /credentials/,
    );
    expect(() => loadTunnelConfig({ TUNNEL_TARGET: 'http://127.0.0.1:9230/mcp' })).toThrow(
      /without a path/,
    );
  });

  it('rejects unknown modes and invalid public URLs', () => {
    expect(() => loadTunnelConfig({ TUNNEL_MODE: 'magic' })).toThrow();
    expect(() => loadTunnelConfig({ TUNNEL_PUBLIC_URL: 'not a url' })).toThrow();
    expect(() => loadTunnelConfig({ TUNNEL_PUBLIC_URL: 'ftp://example.com' })).toThrow(/scheme/);
  });

  it('never includes the tunnel token in the parsed config', () => {
    const config = loadTunnelConfig({ [TUNNEL_TOKEN_ENV]: 'super-secret' });
    expect(JSON.stringify(config)).not.toContain('super-secret');
  });

  it('describeConfigError renders zod messages compactly', () => {
    try {
      loadTunnelConfig({ TUNNEL_TARGET: 'http://10.0.0.5:9230' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(describeConfigError(error)).toContain('loopback');
    }
    expect(describeConfigError(new Error('boom'))).toBe('boom');
    expect(describeConfigError('raw')).toBe('raw');
  });
});

describe('tunnelToken', () => {
  it(`reads only ${TUNNEL_TOKEN_ENV} and treats empty as absent`, () => {
    expect(tunnelToken({ [TUNNEL_TOKEN_ENV]: 'abc123' })).toBe('abc123');
    expect(tunnelToken({ [TUNNEL_TOKEN_ENV]: '' })).toBeUndefined();
    expect(tunnelToken({})).toBeUndefined();
  });
});

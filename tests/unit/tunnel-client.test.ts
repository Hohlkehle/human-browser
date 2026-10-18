/**
 * Stage 7 unit tests: tunnel-client pure helpers — quick-tunnel URL parsing,
 * secret redaction for log lines, and the cloudflared argv builder (which must
 * never contain the token).
 */
import { describe, expect, it } from 'vitest';
import {
  buildCloudflaredArgs,
  parseQuickTunnelUrl,
  redactSecret,
} from '../../src/tunnel/client.js';
import type { TunnelConfig } from '../../src/tunnel/config.js';

function config(overrides: Partial<TunnelConfig> = {}): TunnelConfig {
  return {
    target: 'http://127.0.0.1:9230',
    mode: 'named',
    cloudflaredBin: 'cloudflared',
    ...overrides,
  };
}

describe('parseQuickTunnelUrl', () => {
  it('extracts the ephemeral trycloudflare URL from cloudflared output', () => {
    expect(
      parseQuickTunnelUrl('2026-08-27T10:00:00Z INF https://some-random-words.trycloudflare.com'),
    ).toBe('https://some-random-words.trycloudflare.com');
    expect(
      parseQuickTunnelUrl(
        'Your quick Tunnel has been created! Visit it at https://ab-cd.trycloudflare.com (share freely)',
      ),
    ).toBe('https://ab-cd.trycloudflare.com');
  });

  it('ignores unrelated lines and other domains', () => {
    expect(parseQuickTunnelUrl('INF Registered tunnel connection connIndex=1')).toBeUndefined();
    expect(parseQuickTunnelUrl('https://evil.example.com')).toBeUndefined();
    expect(parseQuickTunnelUrl('https://trycloudflare.com')).toBeUndefined();
    expect(parseQuickTunnelUrl('')).toBeUndefined();
  });
});

describe('redactSecret', () => {
  it('replaces every occurrence of the secret', () => {
    expect(redactSecret('token=abc123 again abc123', 'abc123')).toBe(
      'token=[REDACTED] again [REDACTED]',
    );
  });

  it('is a no-op without a secret or without a match', () => {
    expect(redactSecret('hello', undefined)).toBe('hello');
    expect(redactSecret('hello', 'xyz')).toBe('hello');
  });
});

describe('buildCloudflaredArgs', () => {
  it('named mode: token travels via TUNNEL_TOKEN env, never argv', () => {
    expect(buildCloudflaredArgs(config())).toEqual(['--no-autoupdate', 'tunnel', 'run']);
  });

  it('quick mode: points cloudflared at the loopback MCP origin', () => {
    expect(buildCloudflaredArgs(config({ mode: 'quick' }))).toEqual([
      '--no-autoupdate',
      'tunnel',
      '--url',
      'http://127.0.0.1:9230',
    ]);
  });
});

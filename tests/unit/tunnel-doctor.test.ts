/**
 * Stage 7 unit tests: tunnel doctor. Runs against a real loopback MCP HTTP
 * server (fake adapter, no Chrome) and a fake cloudflared binary, covering the
 * full local chain plus the remote-hop "test connection" via TUNNEL_PUBLIC_URL.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { McpHttpServerHandle } from '../../src/mcp/http.js';
import { TUNNEL_TOKEN_ENV } from '../../src/tunnel/config.js';
import { formatDoctorReport, runDoctor, type DoctorCheck } from '../../src/tunnel/doctor.js';
import { startFakeMcpServer } from '../helpers/mcp-test-server.js';

let versionScript: string;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'tunnel-doctor-'));
  versionScript = join(dir, 'fake-cloudflared-version.cjs');
  writeFileSync(versionScript, "console.log('cloudflared version 2025.8.0-fake');\n");
});

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

/** Fake cloudflared: answers `--version` and exits 0. */
function fakeCloudflaredSpawn(
  _command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  return spawn(process.execPath, [versionScript, ...args], options);
}

async function startMcp(): Promise<McpHttpServerHandle> {
  const server = await startFakeMcpServer();
  cleanups.push(() => server.close());
  return server;
}

function check(report: { checks: readonly DoctorCheck[] }, name: string): DoctorCheck {
  const found = report.checks.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`check "${name}" missing from report`);
  return found;
}

describe('runDoctor', () => {
  it('passes the full local chain in quick mode', async () => {
    const mcp = await startMcp();
    const report = await runDoctor({
      env: {
        TUNNEL_TARGET: `http://127.0.0.1:${mcp.port}`,
        TUNNEL_MODE: 'quick',
      },
      spawnImpl: fakeCloudflaredSpawn,
    });

    expect(check(report, 'node-version').status).toBe('ok');
    expect(check(report, 'config').status).toBe('ok');
    expect(check(report, 'cloudflared').status).toBe('ok');
    expect(check(report, 'cloudflared').message).toContain('cloudflared version 2025.8.0-fake');
    expect(check(report, 'tunnel-token').status).toBe('warn');
    expect(check(report, 'mcp-healthz').status).toBe('ok');
    expect(check(report, 'mcp-readyz').status).toBe('ok');
    const protocol = check(report, 'mcp-protocol');
    expect(protocol.status).toBe('ok');
    expect(protocol.message).toContain('15 tools');
    expect(protocol.message).toContain('browser_status answered');
    expect(report.ok).toBe(true);
    expect(formatDoctorReport(report)).toContain('Result: OK');
  }, 30_000);

  it('named mode: token presence decides the tunnel-token check', async () => {
    const mcp = await startMcp();
    const base = {
      TUNNEL_TARGET: `http://127.0.0.1:${mcp.port}`,
      TUNNEL_MODE: 'named',
    };

    const missing = await runDoctor({ env: { ...base }, spawnImpl: fakeCloudflaredSpawn });
    expect(check(missing, 'tunnel-token').status).toBe('fail');
    expect(check(missing, 'tunnel-token').message).toContain(TUNNEL_TOKEN_ENV);
    expect(missing.ok).toBe(false);

    const present = await runDoctor({
      env: { ...base, [TUNNEL_TOKEN_ENV]: 'a-secret-token' },
      spawnImpl: fakeCloudflaredSpawn,
    });
    const tokenCheck = check(present, 'tunnel-token');
    expect(tokenCheck.status).toBe('ok');
    // The secret value must never appear in the report.
    expect(formatDoctorReport(present)).not.toContain('a-secret-token');
    expect(present.ok).toBe(true);
  }, 30_000);

  it('fails when the Browser MCP endpoint is down', async () => {
    const mcp = await startMcp();
    const port = mcp.port;
    await mcp.close(); // double-close in afterEach is a safe no-op

    const report = await runDoctor({
      env: { TUNNEL_TARGET: `http://127.0.0.1:${port}`, TUNNEL_MODE: 'quick' },
      spawnImpl: fakeCloudflaredSpawn,
    });
    expect(check(report, 'mcp-healthz').status).toBe('fail');
    expect(check(report, 'mcp-readyz').status).toBe('fail');
    expect(check(report, 'mcp-protocol').status).toBe('skip');
    expect(report.ok).toBe(false);
    expect(formatDoctorReport(report)).toContain('[FAIL]');
  }, 30_000);

  it('fails when cloudflared is not installed', async () => {
    const mcp = await startMcp();
    const report = await runDoctor({
      env: {
        TUNNEL_TARGET: `http://127.0.0.1:${mcp.port}`,
        TUNNEL_MODE: 'quick',
        TUNNEL_CLOUDFLARED_BIN: 'definitely-missing-cloudflared-xyz',
      },
      // Real spawn: ENOENT must surface as a failed check, not a crash.
    });
    const binary = check(report, 'cloudflared');
    expect(binary.status).toBe('fail');
    expect(binary.message).toMatch(/not found|ENOENT|spawn/i);
    expect(report.ok).toBe(false);
  }, 30_000);

  it('rejects a target that answers 200 but is not the Browser MCP endpoint', async () => {
    // Simulates pointing the tunnel at something else (e.g. raw CDP tooling):
    // healthz answers 200 with foreign JSON — doctor must fail the hop.
    const foreign: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ Browser: 'Chrome', 'Protocol-Version': '1.3' }));
    });
    await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve));
    const port = (foreign.address() as { port: number }).port;
    cleanups.push(() => new Promise((resolve) => foreign.close(() => resolve(undefined))));

    const report = await runDoctor({
      env: { TUNNEL_TARGET: `http://127.0.0.1:${port}`, TUNNEL_MODE: 'quick' },
      spawnImpl: fakeCloudflaredSpawn,
    });
    const healthz = check(report, 'mcp-healthz');
    expect(healthz.status).toBe('fail');
    expect(healthz.message).toContain('Never point the tunnel at raw CDP');
    expect(check(report, 'mcp-protocol').status).toBe('skip');
    expect(report.ok).toBe(false);
  }, 30_000);

  it('verifies the remote hop when TUNNEL_PUBLIC_URL is set (test connection)', async () => {
    const mcp = await startMcp();
    const origin = `http://127.0.0.1:${mcp.port}`;
    const report = await runDoctor({
      env: {
        TUNNEL_TARGET: origin,
        TUNNEL_MODE: 'quick',
        // Pointed at the local server: the remote-hop exchange (healthz +
        // tools/list + browser_status) is identical to what ChatGPT performs.
        TUNNEL_PUBLIC_URL: origin,
      },
      spawnImpl: fakeCloudflaredSpawn,
    });
    const hop = check(report, 'public-hop');
    expect(hop.status).toBe('ok');
    expect(hop.message).toContain('browser_status answered');
    // Non-HTTPS public URLs earn an extra warning under their own check name.
    expect(check(report, 'public-hop-scheme').status).toBe('warn');
    expect(report.ok).toBe(true);
  }, 30_000);

  it('skips dependent checks when the configuration is invalid', async () => {
    const report = await runDoctor({
      env: { TUNNEL_TARGET: 'http://example.com:9230', TUNNEL_MODE: 'quick' },
      spawnImpl: fakeCloudflaredSpawn,
    });
    expect(check(report, 'config').status).toBe('fail');
    expect(check(report, 'cloudflared').status).toBe('skip');
    expect(check(report, 'mcp-protocol').status).toBe('skip');
    expect(report.ok).toBe(false);
  }, 30_000);
});

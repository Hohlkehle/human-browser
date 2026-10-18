/**
 * Stage 7 integration tests: runTunnel against a fake cloudflared (a Node
 * script spawned in place of the real binary). Verifies the security contract:
 * the tunnel token travels via TUNNEL_TOKEN env only (never argv), cloudflared
 * output is screened for the token before logging, the quick-tunnel URL is
 * surfaced, and shutdown via AbortSignal terminates the child.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import pino, { type Logger } from 'pino';
import { beforeAll, describe, expect, it } from 'vitest';
import { runTunnel, TunnelClientError } from '../../src/tunnel/client.js';
import { TUNNEL_TOKEN_ENV } from '../../src/tunnel/config.js';

const FAKE_SCRIPT = `
const fs = require('node:fs');
const mode = process.env.FAKE_CF_MODE;
if (mode === 'named') {
  fs.writeFileSync(
    process.env.FAKE_CF_EVIDENCE,
    JSON.stringify({
      argv: process.argv.slice(2),
      tunnelToken: process.env.TUNNEL_TOKEN ?? null,
    }),
  );
  // Deliberately echo the token: the parent must redact it before logging.
  if (process.env.TUNNEL_TOKEN) {
    process.stdout.write('echo secret ' + process.env.TUNNEL_TOKEN + '\\n');
  }
} else if (mode === 'quick') {
  process.stderr.write('INF +-----------------------------------------------------------+\\n');
  process.stderr.write('INF https://fake-run-abcd1234.trycloudflare.com\\n');
}
setInterval(() => {}, 60_000); // stay alive until the parent kills us
`;

let scriptPath: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'tunnel-run-'));
  scriptPath = join(dir, 'fake-cloudflared.cjs');
  writeFileSync(scriptPath, FAKE_SCRIPT);
});

/** Runs the fake cloudflared script instead of the configured binary. */
function fakeSpawn(_command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  return spawn(process.execPath, [scriptPath, ...args], options);
}

function createCapturingLogger(): { logger: Logger; text: () => string } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  return { logger: pino({ level: 'info' }, sink), text: () => chunks.join('') };
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('runTunnel', () => {
  it('named mode: token via env only (never argv), redacted in logs', async () => {
    const token = 'sekret-token-value-987';
    const evidencePath = join(mkdtempSync(join(tmpdir(), 'tunnel-evidence-')), 'evidence.json');
    const { logger, text } = createCapturingLogger();
    const controller = new AbortController();

    const run = runTunnel({
      env: {
        TUNNEL_MODE: 'named',
        TUNNEL_TARGET: 'http://127.0.0.1:59998', // dead port: pre-flight only warns
        [TUNNEL_TOKEN_ENV]: token,
        FAKE_CF_MODE: 'named',
        FAKE_CF_EVIDENCE: evidencePath,
      },
      logger,
      signal: controller.signal,
      spawnImpl: fakeSpawn,
    });

    await waitFor(() => existsSync(evidencePath));
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
      argv: string[];
      tunnelToken: string | null;
    };
    // cloudflared argv for a named tunnel — the token is NOT part of it.
    expect(evidence.argv).toEqual(['--no-autoupdate', 'tunnel', 'run']);
    expect(evidence.argv).not.toContain(token);
    // The token arrived through the TUNNEL_TOKEN environment variable.
    expect(evidence.tunnelToken).toBe(token);

    controller.abort();
    const result = await run;
    expect(typeof result.exitCode).toBe('number');
    expect(result.publicUrl).toBeUndefined();

    // The fake echoed the token to stdout; the parent log must not contain it.
    await waitFor(() => text().includes('[REDACTED]'));
    expect(text()).not.toContain(token);
  }, 30_000);

  it('quick mode: surfaces the ephemeral public URL and stops on abort', async () => {
    const controller = new AbortController();
    let resolveUrl: ((url: string) => void) | undefined;
    const urlSeen = new Promise<string>((resolve) => {
      resolveUrl = resolve;
    });

    const run = runTunnel({
      env: {
        TUNNEL_MODE: 'quick',
        TUNNEL_TARGET: 'http://127.0.0.1:59998',
        FAKE_CF_MODE: 'quick',
      },
      logger: pino({ level: 'silent' }),
      signal: controller.signal,
      spawnImpl: fakeSpawn,
      onPublicUrl: (url) => resolveUrl?.(url),
    });

    const publicUrl = await urlSeen;
    expect(publicUrl).toBe('https://fake-run-abcd1234.trycloudflare.com');

    controller.abort();
    const result = await run;
    expect(result.publicUrl).toBe('https://fake-run-abcd1234.trycloudflare.com');
    expect(typeof result.exitCode).toBe('number');
  }, 30_000);

  it('refuses named mode without the env token', async () => {
    await expect(
      runTunnel({
        env: { TUNNEL_MODE: 'named', TUNNEL_TARGET: 'http://127.0.0.1:59998' },
        logger: pino({ level: 'silent' }),
        spawnImpl: fakeSpawn,
      }),
    ).rejects.toThrow(new RegExp(TUNNEL_TOKEN_ENV));
  }, 30_000);

  it('rejects with install guidance when the cloudflared binary is missing', async () => {
    const error = await runTunnel({
      env: {
        TUNNEL_MODE: 'quick',
        TUNNEL_TARGET: 'http://127.0.0.1:59998',
        TUNNEL_CLOUDFLARED_BIN: 'no-such-cloudflared-bin-xyz',
      },
      logger: pino({ level: 'silent' }),
      // Real spawn: ENOENT.
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TunnelClientError);
    expect((error as Error).message).toMatch(/failed to start/);
    expect((error as Error).message).toMatch(/cloudflared/);
  }, 30_000);
});

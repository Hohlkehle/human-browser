/**
 * Tunnel client runner (Stage 7).
 *
 * Spawns `cloudflared` as an OUTBOUND-only tunnel to the local, loopback-only
 * Browser MCP endpoint. Neither the CDP port nor the MCP port is ever bound
 * publicly; reachability for cloud clients (ChatGPT) arrives through the
 * Cloudflare edge.
 *
 * Secret hygiene:
 * - the tunnel token is passed to cloudflared through the `TUNNEL_TOKEN`
 *   environment variable — NEVER on the command line (argv is visible to other
 *   local users/processes);
 * - every cloudflared output line is screened for the token before logging;
 * - the token is never written to config files or the repository.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Logger } from 'pino';
import { logger as rootLogger } from '../logging/logger.js';
import { loadTunnelConfig, tunnelToken, TUNNEL_TOKEN_ENV, type TunnelConfig } from './config.js';

/** Injectable child-process spawner (tests substitute a fake cloudflared). */
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export class TunnelClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TunnelClientError';
  }
}

export interface TunnelRunOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: Logger;
  /** Aborting stops cloudflared gracefully (then forcefully after 5 s). */
  readonly signal?: AbortSignal;
  readonly spawnImpl?: SpawnImpl;
  /** Fired once when a quick tunnel reports its ephemeral public URL. */
  readonly onPublicUrl?: (url: string) => void;
}

export interface TunnelRunResult {
  /** cloudflared exit code (1 when the OS terminated the process). */
  readonly exitCode: number;
  /** Quick mode only: the ephemeral `https://*.trycloudflare.com` URL. */
  readonly publicUrl?: string;
}

const QUICK_URL_PATTERN = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/;

/** Extracts the ephemeral quick-tunnel URL from a cloudflared output line. */
export function parseQuickTunnelUrl(line: string): string | undefined {
  return QUICK_URL_PATTERN.exec(line)?.[0];
}

/** Replaces every occurrence of `secret` with `[REDACTED]` (no-op if unset). */
export function redactSecret(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join('[REDACTED]');
}

/**
 * Builds the cloudflared invocation for a tunnel config. The named mode relies
 * on the `TUNNEL_TOKEN` environment variable (supported by cloudflared for
 * Zero Trust tunnels), so the returned argv never contains a secret.
 */
export function buildCloudflaredArgs(config: TunnelConfig): string[] {
  if (config.mode === 'named') {
    return ['--no-autoupdate', 'tunnel', 'run'];
  }
  return ['--no-autoupdate', 'tunnel', '--url', config.target];
}

/**
 * Runs the tunnel until cloudflared exits or `signal` aborts. Resolves with
 * the exit result; rejects only when cloudflared cannot be started at all.
 */
export async function runTunnel(options: TunnelRunOptions = {}): Promise<TunnelRunResult> {
  const env = options.env ?? process.env;
  const config = loadTunnelConfig(env);
  const logger = (options.logger ?? rootLogger).child({ component: 'tunnel-client' });
  const spawnImpl: SpawnImpl = options.spawnImpl ?? (spawn as unknown as SpawnImpl);

  let token: string | undefined;
  if (config.mode === 'named') {
    token = tunnelToken(env);
    if (!token) {
      throw new TunnelClientError(
        `named tunnel requires the secret ${TUNNEL_TOKEN_ENV} in the process environment ` +
          '(never in config files or the repository); set it, or use TUNNEL_MODE=quick for a local test',
      );
    }
  } else {
    logger.warn('quick tunnel: ephemeral unauthenticated *.trycloudflare.com URL — testing only');
  }

  // Non-blocking pre-flight: warn (do not fail) when the MCP endpoint is down;
  // cloudflared would answer 502 until the Browser MCP server starts.
  try {
    const health = await fetch(`${config.target}/healthz`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!health.ok) throw new Error(`healthz answered ${health.status}`);
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      `Browser MCP is not answering at ${config.target}/healthz yet; the tunnel will return 502 until it starts`,
    );
  }

  const args = buildCloudflaredArgs(config);
  logger.info(
    { mode: config.mode, target: config.target, bin: config.cloudflaredBin },
    'starting cloudflared (token passed via environment, never argv)',
  );

  const childEnv: NodeJS.ProcessEnv = { ...env };
  if (token) childEnv.TUNNEL_TOKEN = token;

  let child: ChildProcess;
  try {
    child = spawnImpl(config.cloudflaredBin, args, {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new TunnelClientError(
      `failed to spawn "${config.cloudflaredBin}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return await new Promise<TunnelRunResult>((resolve, reject) => {
    let settled = false;
    let publicUrl: string | undefined;

    const pipeLines = (stream: NodeJS.ReadableStream | null): void => {
      if (!stream) return;
      let buffer = '';
      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          // cloudflared logs to stderr; surface both streams so the quick
          // tunnel URL and connection registrations are visible to the user.
          logger.info({ source: 'cloudflared' }, redactSecret(line, token));
          if (!publicUrl) {
            const found = parseQuickTunnelUrl(line);
            if (found) {
              publicUrl = found;
              logger.info({ publicUrl }, 'tunnel public URL is live');
              options.onPublicUrl?.(found);
            }
          }
        }
      });
    };
    pipeLines(child.stdout);
    pipeLines(child.stderr);

    const onAbort = (): void => {
      logger.info('shutdown requested; stopping cloudflared');
      try {
        // Windows: kill() maps to TerminateProcess (immediate). POSIX: SIGTERM
        // lets cloudflared deregister the tunnel cleanly; SIGKILL is the 5 s
        // fallback (unref'd, never delays our own shutdown).
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      const force = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 5000);
      force.unref();
    };
    const signal = options.signal;
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      reject(
        new TunnelClientError(
          `failed to start "${config.cloudflaredBin}": ${error.message}. ` +
            'Install cloudflared (winget install --id Cloudflare.cloudflared) or point TUNNEL_CLOUDFLARED_BIN at the executable.',
        ),
      );
    });

    child.on('close', (code, signalName) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      const exitCode = code ?? (signalName ? 1 : 0);
      logger.info({ exitCode }, 'cloudflared stopped');
      resolve(publicUrl !== undefined ? { exitCode, publicUrl } : { exitCode });
    });
  });
}

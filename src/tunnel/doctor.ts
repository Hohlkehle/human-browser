/**
 * Tunnel doctor (Stage 7): verifies every hop of
 * `Chrome -> CDP -> Browser MCP -> tunnel-client -> ChatGPT` that is checkable
 * from this machine, and reports a pass/fail line per check.
 *
 * Checks (in order):
 *  1. node-version      Node >= 22
 *  2. config            tunnel env config parses; target is loopback HTTP
 *  3. cloudflared       binary starts and reports a version
 *  4. tunnel-token      named mode: secret present in env (never printed);
 *                       quick mode: warning that it is testing-only
 *  5. mcp-healthz       GET <target>/healthz -> 200 {"status":"ok"}
 *  6. mcp-readyz        GET <target>/readyz  -> 200 {"status":"ok"}
 *  7. mcp-protocol      MCP initialize + tools/list + browser_status call over
 *                       Streamable HTTP (the same exchange MCP Inspector and
 *                       ChatGPT perform); also proves the target is the
 *                       Browser MCP endpoint and NOT raw CDP
 *  8. public-hop        only when TUNNEL_PUBLIC_URL is set: healthz + MCP
 *                       tools/list + browser_status through the public tunnel
 *                       URL — the "test connection" ChatGPT would make
 *                       (public-hop-scheme warns when the URL is not HTTPS)
 *
 * The report is `ok` when no check failed (warnings are acceptable).
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  describeConfigError,
  loadTunnelConfig,
  tunnelToken,
  TUNNEL_TOKEN_ENV,
  type TunnelConfig,
} from './config.js';

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  readonly name: string;
  readonly status: DoctorStatus;
  readonly message: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  /** True when no check failed (warnings do not fail the report). */
  readonly ok: boolean;
}

/** Injectable spawner so tests can substitute a fake cloudflared binary. */
export type DoctorSpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface DoctorOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnImpl?: DoctorSpawnImpl;
  /** Per-check HTTP/protocol budget in milliseconds. */
  readonly timeoutMs?: number;
}

const DEFAULT_CHECK_TIMEOUT_MS = 10_000;

async function fetchHealth(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return {
      ok: false,
      detail: `request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const body = await response.text();
  if (response.status !== 200) {
    return { ok: false, detail: `HTTP ${response.status}` };
  }
  try {
    const parsed = JSON.parse(body) as { status?: unknown };
    if (parsed.status === 'ok') return { ok: true, detail: '200 {"status":"ok"}' };
    return {
      ok: false,
      detail:
        'answered 200 but not {"status":"ok"} — is this really the Browser MCP endpoint? Never point the tunnel at raw CDP',
    };
  } catch {
    return { ok: false, detail: 'answered 200 but the body is not JSON' };
  }
}

/**
 * Performs the same MCP exchange a client (Inspector / ChatGPT) would:
 * initialize, tools/list, and a browser_status call. Returns the tool count
 * and the human-control state on success.
 */
async function probeMcpEndpoint(baseUrl: string): Promise<{ ok: boolean; detail: string }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  const client = new Client({ name: 'tunnel-doctor', version: '0.0.0' });
  try {
    // The SDK's client transport types do not satisfy our
    // `exactOptionalPropertyTypes` view of the Transport interface; the
    // runtime contract is identical.
    await client.connect(transport as unknown as Transport);
    const { tools } = await client.listTools();
    if (!tools.some((tool) => tool.name === 'browser_status')) {
      return {
        ok: false,
        detail: `tools/list returned ${tools.length} tools but browser_status is missing`,
      };
    }
    const result = (await client.callTool({
      name: 'browser_status',
      arguments: {},
    })) as CallToolResult;
    if (result.isError) {
      return { ok: false, detail: 'browser_status returned an error result' };
    }
    const structured = (result.structuredContent ?? {}) as {
      connected?: unknown;
      humanControl?: { state?: unknown };
    };
    return {
      ok: true,
      detail: `tools/list returned ${tools.length} tools; browser_status answered (connected=${String(
        structured.connected,
      )}, humanControl=${String(structured.humanControl?.state)})`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `MCP exchange failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

function probeCloudflaredBinary(
  bin: string,
  spawnImpl: DoctorSpawnImpl,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({
        ok: false,
        detail: `spawn failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    let output = '';
    let settled = false;
    const finish = (ok: boolean, detail: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, detail });
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(false, `did not answer within ${timeoutMs} ms`);
    }, timeoutMs);
    timer.unref();
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(
        false,
        code === 'ENOENT'
          ? 'not found (ENOENT) — install cloudflared or set TUNNEL_CLOUDFLARED_BIN'
          : `spawn error: ${error.message}`,
      );
    });
    child.on('close', (code) => {
      const firstLine = output.trim().split(/\r?\n/, 1)[0] ?? '';
      if (code === 0 && firstLine) finish(true, firstLine);
      else if (code === 0) finish(false, 'exited 0 but printed no version');
      else finish(false, `exited with code ${code}${firstLine ? `: ${firstLine}` : ''}`);
    });
  });
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const spawnImpl: DoctorSpawnImpl = options.spawnImpl ?? (spawn as unknown as DoctorSpawnImpl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const checks: DoctorCheck[] = [];
  const add = (name: string, status: DoctorStatus, message: string): void => {
    checks.push({ name, status, message });
  };

  // 1. Node version.
  const major = Number(process.versions.node.split('.')[0]);
  add(
    'node-version',
    major >= 22 ? 'ok' : 'fail',
    `Node ${process.versions.node} (>= 22 required)`,
  );

  // 2. Tunnel configuration.
  let config: TunnelConfig | undefined;
  try {
    config = loadTunnelConfig(env);
    add('config', 'ok', `target ${config.target}, mode ${config.mode}`);
  } catch (error) {
    add('config', 'fail', describeConfigError(error));
  }

  if (!config) {
    for (const name of [
      'cloudflared',
      'tunnel-token',
      'mcp-healthz',
      'mcp-readyz',
      'mcp-protocol',
    ]) {
      add(name, 'skip', 'skipped: tunnel configuration is invalid');
    }
    return { checks, ok: false };
  }

  // 3. cloudflared binary.
  const binary = await probeCloudflaredBinary(config.cloudflaredBin, spawnImpl, timeoutMs);
  add('cloudflared', binary.ok ? 'ok' : 'fail', binary.detail);

  // 4. Tunnel token (secret presence only — the value is never printed).
  if (config.mode === 'named') {
    const token = tunnelToken(env);
    add(
      'tunnel-token',
      token ? 'ok' : 'fail',
      token
        ? `${TUNNEL_TOKEN_ENV} is set (value is never printed)`
        : `${TUNNEL_TOKEN_ENV} is not set; inject the secret through the environment (never config files or the repository)`,
    );
  } else {
    add(
      'tunnel-token',
      'warn',
      'quick tunnel needs no token but yields an ephemeral unauthenticated *.trycloudflare.com URL — testing only',
    );
  }

  // 5+6. Local MCP health endpoints.
  const healthz = await fetchHealth(`${config.target}/healthz`, timeoutMs);
  add(
    'mcp-healthz',
    healthz.ok ? 'ok' : 'fail',
    `GET ${config.target}/healthz — ${healthz.detail}`,
  );
  const readyz = await fetchHealth(`${config.target}/readyz`, timeoutMs);
  add('mcp-readyz', readyz.ok ? 'ok' : 'fail', `GET ${config.target}/readyz — ${readyz.detail}`);

  // 7. MCP protocol exchange (initialize + tools/list + browser_status).
  if (!healthz.ok) {
    add('mcp-protocol', 'skip', 'skipped: /healthz did not answer');
  } else {
    const protocol = await probeMcpEndpoint(config.target);
    add('mcp-protocol', protocol.ok ? 'ok' : 'fail', protocol.detail);
  }

  // 8. Optional remote hop through the public tunnel URL.
  if (config.publicUrl !== undefined) {
    const publicOrigin = config.publicUrl.replace(/\/$/, '');
    if (!publicOrigin.startsWith('https://')) {
      add(
        'public-hop-scheme',
        'warn',
        `${publicOrigin} is not HTTPS — production tunnels must use https`,
      );
    }
    const remoteHealth = await fetchHealth(`${publicOrigin}/healthz`, timeoutMs);
    if (!remoteHealth.ok) {
      add('public-hop', 'fail', `GET ${publicOrigin}/healthz — ${remoteHealth.detail}`);
    } else {
      const remoteProtocol = await probeMcpEndpoint(publicOrigin);
      add(
        'public-hop',
        remoteProtocol.ok ? 'ok' : 'fail',
        `through ${publicOrigin}: ${remoteHealth.detail}; ${remoteProtocol.detail}`,
      );
    }
  }

  return { checks, ok: checks.every((check) => check.status !== 'fail') };
}

/** Renders the report as aligned, human-readable lines for the CLI. */
export function formatDoctorReport(report: DoctorReport): string {
  const badge: Record<DoctorStatus, string> = {
    ok: '[ ok ]',
    warn: '[warn]',
    fail: '[FAIL]',
    skip: '[skip]',
  };
  const width = Math.max(...report.checks.map((check) => check.name.length));
  const lines = report.checks.map(
    (check) => `${badge[check.status]} ${check.name.padEnd(width)} — ${check.message}`,
  );
  const counts = report.checks.reduce(
    (acc, check) => ({ ...acc, [check.status]: (acc[check.status] ?? 0) + 1 }),
    {} as Record<DoctorStatus, number>,
  );
  const summary = report.checks
    .map((check) => check.status)
    .filter((status, index, all) => all.indexOf(status) === index)
    .map((status) => `${counts[status] ?? 0} ${status}`)
    .join(', ');
  lines.push(
    '',
    `Result: ${report.ok ? 'OK' : 'FAIL'} (${report.checks.length} checks: ${summary})`,
  );
  return lines.join('\n');
}

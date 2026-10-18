/**
 * Tunnel client CLI (Stage 7).
 *
 * Usage:
 *   node dist/src/tunnel-cli.js doctor   verify the local chain + prerequisites
 *   node dist/src/tunnel-cli.js run      start the outbound tunnel (cloudflared)
 *
 * Exit codes: doctor 0 = all checks passed (warnings allowed), 1 = failure;
 * run exits with cloudflared's exit code (1 on startup failure). The tunnel
 * token comes from the CLOUDFLARE_TUNNEL_TOKEN environment variable only —
 * it is never read from config files, argv, or the repository.
 */
import { runTunnel } from './tunnel/client.js';
import { formatDoctorReport, runDoctor } from './tunnel/doctor.js';
import { logger } from './logging/logger.js';

const USAGE = `Browser MCP tunnel client (Stage 7)

Gives cloud ChatGPT access to the local, loopback-only MCP endpoint without
publishing the CDP or MCP ports: cloudflared dials OUT to Cloudflare and
forwards back to http://127.0.0.1:9230. See docs/tunnel-client.md.

Usage: node dist/src/tunnel-cli.js <command>

Commands:
  doctor   Verify Chrome -> CDP -> Browser MCP -> tunnel prerequisites
           (healthz/readyz, MCP tools/list + browser_status, cloudflared,
           token presence; with TUNNEL_PUBLIC_URL also the remote hop).
  run      Start the outbound tunnel and keep it running (Ctrl+C stops).

Environment:
  TUNNEL_TARGET            local MCP origin (default http://127.0.0.1:9230)
  TUNNEL_MODE              named (default) | quick (testing only)
  TUNNEL_CLOUDFLARED_BIN   cloudflared executable (default: PATH lookup)
  TUNNEL_PUBLIC_URL        optional public URL verified by doctor
  CLOUDFLARE_TUNNEL_TOKEN  secret tunnel token (named mode; env only)
`;

async function main(): Promise<number> {
  const command = process.argv[2];
  switch (command) {
    case 'doctor': {
      const report = await runDoctor();
      process.stdout.write(`${formatDoctorReport(report)}\n`);
      return report.ok ? 0 : 1;
    }
    case 'run': {
      const controller = new AbortController();
      const stop = (signal: string): void => {
        logger.info({ signal }, 'tunnel-client shutdown requested');
        controller.abort();
      };
      process.once('SIGINT', () => stop('SIGINT'));
      process.once('SIGTERM', () => stop('SIGTERM'));
      try {
        const result = await runTunnel({ signal: controller.signal });
        return result.exitCode === 0 ? 0 : 1;
      } catch (error) {
        logger.fatal({ err: error }, 'tunnel-client failed');
        return 1;
      }
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return command === undefined ? 2 : 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    logger.fatal({ err: error }, 'tunnel-client crashed');
    process.exitCode = 1;
  });

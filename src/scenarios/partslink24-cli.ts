/**
 * Partslink24 end-to-end scenario CLI (Stage 9) — the REAL-site run.
 *
 * Plays the MCP client role against a running Browser MCP server and drives
 * the full scenario on www.partslink24.com:
 *
 *   open -> login wall? hand over to the user -> VIN search -> CAPTCHA?
 *   hand over to the user -> extract part numbers + applicability.
 *
 * The CLI prompts on the console whenever the human must act in the visible
 * Chrome (sign in, solve a CAPTCHA) and resumes only after confirmation.
 * Credentials are typed by the user into Chrome only — never into this CLI,
 * never into the MCP server. The VIN appears masked in all output.
 *
 * Usage:
 *   node dist/src/scenarios/partslink24-cli.js [--vin <VIN>] [--endpoint <url>]
 *
 * The VIN comes from --vin, the PL24_VIN environment variable, or an
 * interactive prompt (argv is visible to other local processes; prefer the
 * env variable or the prompt). Exit code: 0 = scenario completed, 1 = failed.
 */
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import pino from 'pino';
import {
  formatScenarioReport,
  runPartslink24Scenario,
  type ScenarioHandoff,
} from './partslink24.js';
import { maskVin, redactVinsInText } from '../policy/vin.js';

const USAGE = `Browser MCP — Partslink24 end-to-end scenario (Stage 9)

Drives the real scenario against www.partslink24.com through a running
Browser MCP server. When the site needs the user (login, CAPTCHA) the CLI
pauses and prompts here; finish the action in the visible Chrome window and
press Enter to resume. See docs/partslink24-e2e.md.

Usage: node dist/src/scenarios/partslink24-cli.js [options]

Options:
  --vin <VIN>        VIN to search (or PL24_VIN env, or interactive prompt)
  --endpoint <url>   MCP endpoint (default http://127.0.0.1:9230/mcp or
                     MCP_ENDPOINT env)
  -h, --help         show this help

The CLI never asks for a password and never confirms a purchase or order.
`;

function parseArgs(argv: readonly string[]): {
  vin?: string;
  endpoint?: string;
  help: boolean;
} {
  let vin: string | undefined;
  let endpoint: string | undefined;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--vin') {
      vin = argv[index + 1];
      index += 1;
    } else if (arg === '--endpoint') {
      endpoint = argv[index + 1];
      index += 1;
    } else if (arg === '--help' || arg === '-h' || arg === 'help') {
      help = true;
    }
  }
  return {
    ...(vin !== undefined ? { vin } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
    help,
  };
}

function ask(readline: ReadlineInterface, question: string): Promise<string> {
  return new Promise((resolve) => {
    readline.question(question, (answer) => resolve(answer.trim()));
  });
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const vin = args.vin ?? process.env.PL24_VIN ?? (await ask(readline, 'VIN to search: '));
  if (vin === '') {
    process.stderr.write('No VIN given; nothing to do.\n');
    readline.close();
    return 1;
  }

  const endpoint = args.endpoint ?? process.env.MCP_ENDPOINT ?? 'http://127.0.0.1:9230/mcp';
  const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' }, pino.destination(2));

  process.stdout.write(`\nPartslink24 E2E — VIN ${maskVin(vin)} via ${endpoint}\n`);
  process.stdout.write('Keep the visible Chrome window in sight; prompts appear here.\n\n');

  const client = new Client({ name: 'partslink24-e2e-cli', version: '0.1.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint)) as unknown as Transport,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `Cannot reach the MCP server at ${endpoint}: ${redactVinsInText(message)}\n` +
        'Start it first (npm start) — see docs/partslink24-e2e.md.\n',
    );
    readline.close();
    return 1;
  }

  let handoffNumber = 0;
  const report = await runPartslink24Scenario({
    call: async (tool, callArgs) => {
      const result = (await client.callTool({
        name: tool,
        arguments: callArgs ?? {},
      })) as CallToolResult;
      return result;
    },
    waitForUser: async (handoff: ScenarioHandoff) => {
      handoffNumber += 1;
      process.stdout.write(`\n--- HANDOFF #${handoffNumber} (${handoff.kind}) ---\n`);
      process.stdout.write(`${handoff.reason}\n`);
      process.stdout.write(
        handoff.kind === 'login'
          ? 'Sign in in the visible Chrome window (type your credentials THERE, never here).\n'
          : 'Complete the CAPTCHA in the visible Chrome window.\n',
      );
      await ask(readline, 'Press Enter when you are done (or Ctrl+C to abort)... ');
    },
    vin,
    logger,
  });

  process.stdout.write('\n');
  process.stdout.write(`${formatScenarioReport(report)}\n`);

  await client.close().catch(() => {});
  readline.close();
  return report.ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`partslink24-e2e crashed: ${redactVinsInText(message)}\n`);
    process.exitCode = 1;
  });

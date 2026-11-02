/**
 * Stage 5 integration tests: the real server process over the STDIO
 * transport (`node --import tsx src/main.ts` with MCP_TRANSPORT=stdio).
 * No Chrome is needed: tools/list, instructions and browser_status work
 * before any browser connection.
 */
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

let transport: StdioClientTransport | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  await transport?.close();
  client = undefined;
  transport = undefined;
});

async function connectStdio(): Promise<Client> {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/main.ts'],
    cwd: REPO_ROOT,
    env: {
      ...getDefaultEnvironment(),
      MCP_TRANSPORT: 'stdio',
      GATEWAY_ENABLED: 'false',
      CDP_ENDPOINT: 'http://127.0.0.1:59999',
      LOG_LEVEL: 'silent',
    },
    stderr: 'pipe',
  });
  client = new Client({ name: 'stdio-integration-client', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

describe('MCP server over STDIO (real process)', () => {
  it('initializes, exposes instructions and all 16 tools', async () => {
    const stdio = await connectStdio();

    expect(stdio.getServerVersion()?.name).toBe('browser-mcp');
    expect(stdio.getInstructions()).toContain('Security rules');

    const { tools } = await stdio.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'browser_connect',
      'browser_status',
      'human_required',
      'human_resume',
      'page_click',
      'page_close',
      'page_extract',
      'page_fill',
      'page_list',
      'page_navigate',
      'page_open',
      'page_press',
      'page_screenshot',
      'page_select',
      'page_snapshot',
      'page_wait',
    ]);
  }, 60_000);

  it('answers browser_status before any connection and structured errors after', async () => {
    const stdio = await connectStdio();

    const status = (await stdio.callTool({
      name: 'browser_status',
      arguments: {},
    })) as CallToolResult;
    expect(status.isError).toBeFalsy();
    const structured = (status.structuredContent ?? {}) as Record<string, unknown>;
    expect(structured.connected).toBe(false);
    expect(structured.humanControl).toEqual({ state: 'ready' });

    // The configured endpoint is dead: connect must fail with a structured,
    // typed error — never a raw exception or a secret path.
    const connect = (await stdio.callTool({
      name: 'browser_connect',
      arguments: {},
    })) as CallToolResult;
    expect(connect.isError).toBe(true);
    const error = ((connect.structuredContent ?? {}) as Record<string, unknown>).error as {
      code: string;
      retryable: boolean;
    };
    expect(['connect_failed', 'endpoint_forbidden', 'timeout']).toContain(error.code);
    expect(error.retryable).toBe(true);

    const blocked = (await stdio.callTool({
      name: 'page_navigate',
      arguments: { pageId: 'page-1', url: 'https://partslink24.com/' },
    })) as CallToolResult;
    expect(blocked.isError).toBe(true);
    expect(
      (((blocked.structuredContent ?? {}) as Record<string, unknown>).error as { code: string })
        .code,
    ).toBe('not_connected');
  }, 90_000);

  it('keeps stdout protocol-clean (logs go to stderr)', async () => {
    const stdio = await connectStdio();
    // If any log line leaked to stdout, the JSON-RPC framing would break and
    // the initialize/listTools above would already have failed. Reaching this
    // point with a live session is the assertion; additionally confirm the
    // child stderr carries no protocol-looking lines.
    const stderr = transport?.stderr as NodeJS.ReadableStream | null;
    let stderrText = '';
    stderr?.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString('utf8');
    });
    await stdio.listTools();
    expect(stderrText).not.toContain('"jsonrpc"');
  }, 60_000);
});

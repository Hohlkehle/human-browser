import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createBrowserAdapter } from './browser/adapter.js';
import { createCdpGateway, type CdpGatewayHandle } from './cdp/gateway.js';
import {
  deriveAdapterHeaders,
  loadConfig,
  requiredSecret,
  validateStartupSecurity,
  type AppConfig,
} from './config/index.js';
import { createHumanGate } from './human/gate.js';
import { logger } from './logging/logger.js';
import { createMcpHttpServer, type McpHttpServerHandle } from './mcp/http.js';
import { createBrowserMcpServer, type BrowserMcpServerHandle } from './mcp/server.js';
import { createSpecStore } from './spec/index.js';
import { createDomainPolicy } from './policy/domains.js';

function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

let config: AppConfig;
try {
  config = loadConfig();
  validateStartupSecurity(config);
} catch (error) {
  logger.fatal({ err: error }, 'startup failed');
  process.exit(1);
}

let shuttingDown = false;
let gateway: CdpGatewayHandle | undefined;
let mcp: BrowserMcpServerHandle | undefined;
let stdioServer: McpServer | undefined;
let mcpHttp: McpHttpServerHandle | undefined;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutdown requested');

  // 1. Stop accepting MCP requests (closes the transport and SSE streams).
  if (mcpHttp) {
    try {
      await mcpHttp.close();
    } catch (error) {
      logger.error({ err: error }, 'mcp http shutdown failed');
      process.exitCode = 1;
    }
  } else if (stdioServer) {
    try {
      await stdioServer.close();
    } catch (error) {
      logger.error({ err: error }, 'mcp stdio shutdown failed');
      process.exitCode = 1;
    }
    stdioServer = undefined;
  }

  // 2. Detach from Chrome; the user's browser and its tabs keep running.
  if (mcp) {
    // Stop the human-control wait timer (already unref'd; belt and braces).
    mcp.humanGate.dispose();
    try {
      await mcp.adapter.dispose();
    } catch (error) {
      logger.error({ err: error }, 'browser adapter shutdown failed');
    }
  }

  // 3. Close the CDP gateway: it terminates proxied WebSockets explicitly so
  // long-lived CDP sessions cannot delay termination.
  if (gateway) {
    try {
      await gateway.close();
    } catch (error) {
      logger.error({ err: error }, 'gateway shutdown failed');
      process.exitCode = 1;
    }
  }
  logger.info('server stopped');
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  if (config.gateway.enabled) {
    gateway = await createCdpGateway({
      listenHost: config.gateway.listenHost,
      listenPort: config.gateway.listenPort,
      target: config.gateway.target,
      // validateStartupSecurity guarantees this is non-empty when enabled.
      bearerToken: requiredSecret(config) ?? '',
      allowedCidrs: config.gateway.allowedCidrs,
      targetAllowedCidrs: config.cdp.allowedCidrs,
      rateLimitWindowMs: config.gateway.rateLimitWindowMs,
      rateLimitMax: config.gateway.rateLimitMax,
    });
    await gateway.listen();
  }

  const adapterHeaders = deriveAdapterHeaders(config);
  const adapter = createBrowserAdapter({
    endpoint: config.cdp.endpoint,
    allowedCidrs: config.cdp.allowedCidrs,
    operationTimeoutMs: config.operationTimeoutMs,
    // Stage 6: the user must SEE the tab to take over (CAPTCHA/login); refuse
    // headless browsers unless explicitly disabled (automated tests only).
    visibleModeRequired: config.browser.visibleModeRequired,
    // When the CDP endpoint points at our own enabled gateway, authenticate
    // with the gateway bearer; a direct Chrome endpoint gets no headers.
    ...(adapterHeaders !== undefined ? { headers: adapterHeaders } : {}),
  });

  // Stage 6 human-control state machine: waits for the user at most
  // HUMAN_TIMEOUT_MS before failing itself; the timer is unref'd and disposed
  // on shutdown, so it never delays termination.
  const humanGate = createHumanGate({
    timeoutMs: config.humanTimeoutMs,
    onTimeout: (snapshot) => {
      logger.warn(
        { pageId: snapshot.pageId, reason: snapshot.reason },
        'human-control wait timed out; state is now failed (automation stays blocked)',
      );
    },
  });

  mcp = createBrowserMcpServer({
    adapter,
    domainPolicy: createDomainPolicy([]),
    humanGate,
    specStore: createSpecStore(config.siteSpecsDir),
    version: readPackageVersion(),
  });
  logger.info({ siteSpecsDir: config.siteSpecsDir }, 'learned site specs directory configured');

  if (config.mcp.transport === 'stdio') {
    // STDIO: stdout belongs to the MCP protocol; logs already go to stderr.
    // No HTTP listener is bound in this mode — the MCP client owns the
    // process lifecycle, so when the client disconnects (stdin EOF) the
    // whole server shuts down.
    stdioServer = mcp.build();
    stdioServer.server.onclose = () => {
      if (!shuttingDown) void shutdown('SIGTERM');
    };
    await stdioServer.connect(new StdioServerTransport());
    logger.info({ transport: 'stdio' }, 'Browser MCP started');
  } else {
    mcpHttp = await createMcpHttpServer({
      buildMcpServer: () => mcp!.build(),
      listenHost: config.mcp.listenHost,
      listenPort: config.mcp.listenPort,
    });
    logger.info(
      {
        host: mcpHttp.host,
        port: mcpHttp.port,
        transport: 'streamable-http',
        endpoint: `${config.mcp.listenHost}:${mcpHttp.port}/mcp`,
      },
      'Browser MCP started',
    );
  }
} catch (error) {
  logger.fatal({ err: error }, 'startup failed');
  process.exit(1);
}

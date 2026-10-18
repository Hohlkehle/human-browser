import { z } from 'zod';
import { parseCidr } from '../cdp/ip.js';

const port = z.coerce.number().int().min(1).max(65535);
const positiveMilliseconds = z.coerce.number().int().positive();

const ALLOWED_CDP_SCHEMES = ['http:', 'https:', 'ws:', 'wss:'];

/** CDP endpoint: valid URL, http/https/ws/wss only, never with credentials. */
const cdpEndpoint = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'cdp.endpoint must be a valid URL' });
      return;
    }
    if (!ALLOWED_CDP_SCHEMES.includes(url.protocol)) {
      ctx.addIssue({
        code: 'custom',
        message: `cdp.endpoint scheme "${url.protocol}" is not allowed; use http/https/ws/wss`,
      });
    }
    if (url.username !== '' || url.password !== '') {
      ctx.addIssue({
        code: 'custom',
        message: 'cdp.endpoint must not contain credentials',
      });
    }
  });

const cidr = z
  .string()
  .min(1)
  .refine((value) => parseCidr(value) !== undefined, {
    message: 'must be a valid CIDR (e.g. 10.0.0.0/8)',
  });

export const configSchema = z.object({
  cdp: z.object({
    endpoint: cdpEndpoint,
    allowedCidrs: z.array(cidr).min(1),
  }),
  gateway: z.object({
    enabled: z.boolean(),
    listenHost: z.string().min(1),
    listenPort: port,
    target: z.string().url(),
    allowedCidrs: z.array(cidr).min(1),
    bearerTokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    rateLimitWindowMs: positiveMilliseconds,
    rateLimitMax: z.coerce.number().int().positive(),
  }),
  browser: z.object({
    visibleModeRequired: z.boolean(),
  }),
  mcp: z.object({
    transport: z.enum(['stdio', 'streamable-http']),
    listenHost: z.string().min(1),
    listenPort: port,
  }),
  operationTimeoutMs: positiveMilliseconds,
  humanTimeoutMs: positiveMilliseconds,
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const raw = {
    cdp: {
      endpoint: environment.CDP_ENDPOINT ?? 'http://127.0.0.1:9222',
      allowedCidrs: (
        environment.CDP_ALLOWED_CIDRS ?? '127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16'
      )
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    },
    gateway: {
      enabled: environment.GATEWAY_ENABLED !== 'false',
      listenHost: environment.GATEWAY_LISTEN_HOST ?? '127.0.0.1',
      listenPort: environment.GATEWAY_LISTEN_PORT ?? '9229',
      target: environment.GATEWAY_TARGET ?? 'http://127.0.0.1:9222',
      allowedCidrs: (environment.GATEWAY_ALLOWED_CIDRS ?? '127.0.0.1/32')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
      bearerTokenEnv: environment.GATEWAY_BEARER_TOKEN_ENV ?? 'CDP_GATEWAY_TOKEN',
      rateLimitWindowMs: environment.GATEWAY_RATE_LIMIT_WINDOW_MS ?? '60000',
      rateLimitMax: environment.GATEWAY_RATE_LIMIT_MAX ?? '120',
    },
    browser: {
      visibleModeRequired: environment.BROWSER_VISIBLE_MODE_REQUIRED !== 'false',
    },
    mcp: {
      transport: environment.MCP_TRANSPORT ?? 'streamable-http',
      listenHost: environment.MCP_LISTEN_HOST ?? '127.0.0.1',
      listenPort: environment.MCP_LISTEN_PORT ?? '9230',
    },
    operationTimeoutMs: environment.MCP_OPERATION_TIMEOUT_MS ?? '30000',
    humanTimeoutMs: environment.HUMAN_TIMEOUT_MS ?? '300000',
  };

  return configSchema.parse(raw);
}

export function requiredSecret(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!config.gateway.enabled) return undefined;
  return environment[config.gateway.bearerTokenEnv];
}

/**
 * Derives the extra headers for the browser adapter when the CDP endpoint
 * points at our own enabled gateway: the adapter then authenticates with the
 * gateway bearer token. Returns undefined for a direct Chrome endpoint (or a
 * disabled gateway), so the token is never sent anywhere else.
 */
export function deriveAdapterHeaders(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  if (!config.gateway.enabled) return undefined;
  const token = requiredSecret(config, environment);
  if (!token) return undefined;
  let endpoint: URL;
  try {
    endpoint = new URL(config.cdp.endpoint);
  } catch {
    return undefined;
  }
  if (Number(endpoint.port) !== config.gateway.listenPort) return undefined;
  const gatewayHost = config.gateway.listenHost.toLowerCase();
  const endpointHost = endpoint.hostname.toLowerCase();
  const wildcardBind = gatewayHost === '0.0.0.0' || gatewayHost === '::' || gatewayHost === '[::]';
  if (!wildcardBind && endpointHost !== gatewayHost) return undefined;
  return { Authorization: `Bearer ${token}` };
}

export function validateStartupSecurity(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (!config.gateway.enabled) return;
  // An enabled gateway refuses to start without BOTH a bearer token and a
  // non-empty CIDR allowlist, regardless of the bind address. A 0.0.0.0 bind
  // additionally depends on the OS firewall (see docs/windows-firewall.md).
  if (config.gateway.allowedCidrs.length === 0) {
    throw new Error('Gateway refuses to start without allowedCidrs');
  }
  if (!requiredSecret(config, environment)) {
    throw new Error(`Gateway refuses to start without secret ${config.gateway.bearerTokenEnv}`);
  }
}

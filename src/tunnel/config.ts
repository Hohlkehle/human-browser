/**
 * Tunnel client configuration (Stage 7).
 *
 * The tunnel gives cloud clients (e.g. ChatGPT) reachability WITHOUT publishing
 * the CDP port or binding the MCP server to a public address: cloudflared makes
 * an OUTBOUND connection to Cloudflare and forwards back to the local,
 * loopback-only Browser MCP endpoint.
 *
 * Secret handling: the tunnel API key / tunnel token is NEVER part of this
 * configuration and is never stored in the repository. It is read at runtime
 * from the environment variable named by {@link TUNNEL_TOKEN_ENV} only.
 */
import { z } from 'zod';

/**
 * Name of the environment variable holding the Cloudflare tunnel token.
 * Only the NAME lives in code/config; the VALUE must be injected through the
 * process environment or a protected OS secret store — never committed.
 */
export const TUNNEL_TOKEN_ENV = 'CLOUDFLARE_TUNNEL_TOKEN';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);

/**
 * Tunnel origin: the local Browser MCP endpoint. Plain HTTP on loopback only,
 * no credentials, no path. The tunnel must NEVER point at raw CDP (9222) or
 * anything else: raw CDP bypasses every policy layer (domain allowlist,
 * redaction, human gate), which is exactly what Stage 7 must not publish.
 */
const tunnelTarget = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'tunnel.target must be a valid URL' });
      return;
    }
    if (url.protocol !== 'http:') {
      ctx.addIssue({
        code: 'custom',
        message: `tunnel.target scheme "${url.protocol}" is not allowed; the origin is plain local HTTP (cloudflared connects on the local machine)`,
      });
    }
    // URL keeps IPv6 literals bracketed (`[::1]`); fold them back to bare.
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!LOOPBACK_HOSTS.has(host)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'tunnel.target must be loopback (127.0.0.1 or ::1): the tunnel only forwards to the local Browser MCP endpoint',
      });
    }
    if (url.username !== '' || url.password !== '') {
      ctx.addIssue({ code: 'custom', message: 'tunnel.target must not contain credentials' });
    }
    if (url.pathname !== '/' && url.pathname !== '') {
      ctx.addIssue({
        code: 'custom',
        message: 'tunnel.target must be an origin without a path (e.g. http://127.0.0.1:9230)',
      });
    }
  });

/** Public tunnel URL used by `doctor` for the remote-hop verification only. */
const tunnelPublicUrl = z
  .string()
  .url()
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'tunnel.publicUrl must be a valid URL' });
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      ctx.addIssue({
        code: 'custom',
        message: `tunnel.publicUrl scheme "${url.protocol}" is not allowed; use http/https`,
      });
    }
  });

export const tunnelConfigSchema = z.object({
  /** Local Browser MCP endpoint the tunnel forwards to. */
  target: tunnelTarget,
  /**
   * `named`: a Cloudflare Zero Trust tunnel authenticated with the token from
   * {@link TUNNEL_TOKEN_ENV} (stable hostname, production use).
   * `quick`: an ephemeral, unauthenticated `*.trycloudflare.com` URL — testing
   * only, the URL changes on every start.
   */
  mode: z.enum(['named', 'quick']),
  /** cloudflared executable (PATH name or absolute path). */
  cloudflaredBin: z.string().min(1),
  /** Optional public URL verified by `doctor` (healthz + MCP tools/list). */
  publicUrl: tunnelPublicUrl.optional(),
});

export type TunnelConfig = z.infer<typeof tunnelConfigSchema>;

export function loadTunnelConfig(environment: NodeJS.ProcessEnv = process.env): TunnelConfig {
  const raw: {
    target: string;
    mode: string;
    cloudflaredBin: string;
    publicUrl?: string | undefined;
  } = {
    target: environment.TUNNEL_TARGET ?? 'http://127.0.0.1:9230',
    mode: environment.TUNNEL_MODE ?? 'named',
    cloudflaredBin: environment.TUNNEL_CLOUDFLARED_BIN ?? 'cloudflared',
  };
  const publicUrl = environment.TUNNEL_PUBLIC_URL;
  if (publicUrl !== undefined && publicUrl !== '') raw.publicUrl = publicUrl;
  return tunnelConfigSchema.parse(raw);
}

/**
 * Reads the tunnel token from the environment. Returns undefined when absent;
 * the value is never persisted, logged, or placed on a command line.
 */
export function tunnelToken(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = environment[TUNNEL_TOKEN_ENV];
  return value === undefined || value === '' ? undefined : value;
}

/** Compact human-readable rendering of a Zod validation failure. */
export function describeConfigError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => issue.message).join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

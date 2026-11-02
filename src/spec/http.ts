/**
 * Plain-HTTP transport for spec ops — the cheap default: no browser, no
 * rendering. Ported from the Python caller with the same retry contract
 * (5xx and network errors retry, everything else returns as-is so the caller
 * can tell 403/429 apart from a transient 500).
 */

import type { Logger } from 'pino';

export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) Firefox/132.0';

export interface HttpRequestOptions {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | null;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly retryWaitMs: number;
  /** Cap on the body we keep; a huge page must not become a huge tool result. */
  readonly maxChars: number;
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
}

export interface HttpTextResponse {
  /** HTTP status, or 0 when the request never produced a response. */
  readonly status: number;
  readonly text: string;
  readonly truncated: boolean;
}

const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function fetchText(options: HttpRequestOptions): Promise<HttpTextResponse> {
  const headers: Record<string, string> = { 'user-agent': DEFAULT_USER_AGENT };
  for (const [key, value] of Object.entries(options.headers)) {
    if (key.toLowerCase() !== 'user-agent') headers[key] = value;
  }
  if (options.headers['user-agent'] !== undefined) headers['user-agent'] = options.headers['user-agent'];

  let lastStatus = 0;
  let lastText = '';

  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
    const signal =
      options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);
    try {
      const response = await fetch(options.url, {
        method: options.method,
        headers,
        ...(options.body !== undefined && options.body !== null ? { body: options.body } : {}),
        redirect: 'follow',
        signal,
      });
      const raw = await response.text();
      const truncated = raw.length > options.maxChars;
      const text = truncated ? raw.slice(0, options.maxChars) : raw;
      if (RETRYABLE_STATUS.has(response.status) && attempt < options.retries) {
        options.logger?.warn(
          { status: response.status, attempt: attempt + 1, url: options.url },
          'spec http: retryable status, retrying',
        );
        await sleep(options.retryWaitMs);
        lastStatus = response.status;
        lastText = text;
        continue;
      }
      return { status: response.status, text, truncated };
    } catch (error) {
      // Network level: no response at all. Retry while attempts remain, then
      // report status 0 so the tool can say "no response" instead of "empty".
      lastStatus = 0;
      lastText = error instanceof Error ? error.message : String(error);
      if (attempt < options.retries) {
        options.logger?.warn(
          { attempt: attempt + 1, url: options.url },
          'spec http: network error, retrying',
        );
        await sleep(options.retryWaitMs);
        continue;
      }
    }
  }
  return { status: lastStatus, text: lastText, truncated: false };
}

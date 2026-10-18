import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { BrowserAdapterError, createBrowserAdapter } from '../../src/browser/adapter.js';
import { LocatorSpecError, validateLocatorSpec } from '../../src/browser/locator.js';

async function expectAdapterError(
  fn: () => Promise<unknown>,
  code: string,
): Promise<BrowserAdapterError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserAdapterError);
    expect((error as BrowserAdapterError).code).toBe(code);
    return error as BrowserAdapterError;
  }
  throw new Error(`expected BrowserAdapterError(${code}) but no error was thrown`);
}

async function findDeadPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('createBrowserAdapter: configuration validation', () => {
  it('requires a non-empty endpoint', () => {
    expect(() => createBrowserAdapter({ endpoint: '' })).toThrowError(BrowserAdapterError);
    expect(() => createBrowserAdapter({ endpoint: '   ' })).toThrowError(BrowserAdapterError);
  });

  it('rejects an endpoint that is not a URL', () => {
    try {
      createBrowserAdapter({ endpoint: 'not a url' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as BrowserAdapterError).code).toBe('invalid_config');
    }
  });

  it('rejects non-positive limits', () => {
    const base = { endpoint: 'http://127.0.0.1:9222' };
    expect(() => createBrowserAdapter({ ...base, maxTabs: 0 })).toThrowError(BrowserAdapterError);
    expect(() => createBrowserAdapter({ ...base, maxConcurrentOperations: 0 })).toThrowError(
      BrowserAdapterError,
    );
    expect(() => createBrowserAdapter({ ...base, maxQueuedOperations: -1 })).toThrowError(
      BrowserAdapterError,
    );
    expect(() => createBrowserAdapter({ ...base, operationTimeoutMs: 0 })).toThrowError(
      BrowserAdapterError,
    );
  });

  it('rejects empty header values', () => {
    try {
      createBrowserAdapter({ endpoint: 'http://127.0.0.1:9222', headers: { Authorization: '' } });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as BrowserAdapterError).code).toBe('invalid_config');
    }
  });
});

describe('BrowserAdapter: state before connect', () => {
  it('refuses operations with not_connected before connect()', async () => {
    const adapter = createBrowserAdapter({ endpoint: 'http://127.0.0.1:9222' });
    expect(adapter.isConnected()).toBe(false);
    expect(adapter.status().connected).toBe(false);
    await expectAdapterError(() => adapter.listPages(), 'not_connected');
    await expectAdapterError(() => adapter.openPage(), 'not_connected');
    await expectAdapterError(
      () => adapter.navigate({ pageId: 'page-1', url: 'http://127.0.0.1/' }),
      'not_connected',
    );
    // Stage 6 human-control operations follow the same rule.
    await expectAdapterError(() => adapter.challengeScan({ pageId: 'page-1' }), 'not_connected');
    await expectAdapterError(() => adapter.bringToFront({ pageId: 'page-1' }), 'not_connected');
    await expectAdapterError(
      () => adapter.describeLocator({ pageId: 'page-1', locator: { kind: 'css', selector: '#x' } }),
      'not_connected',
    );
  });

  it('refuses everything after dispose()', async () => {
    const adapter = createBrowserAdapter({ endpoint: 'http://127.0.0.1:9222' });
    await adapter.dispose();
    await expectAdapterError(() => adapter.connect(), 'closed');
    await expectAdapterError(() => adapter.listPages(), 'closed');
  });

  it('disconnect before connect is a no-op', async () => {
    const adapter = createBrowserAdapter({ endpoint: 'http://127.0.0.1:9222' });
    await expect(adapter.disconnect()).resolves.toBeUndefined();
  });
});

describe('BrowserAdapter: endpoint policy', () => {
  it('rejects a public endpoint before any connection attempt', async () => {
    const adapter = createBrowserAdapter({ endpoint: 'http://8.8.8.8:9222' });
    const error = await expectAdapterError(() => adapter.connect(), 'endpoint_forbidden');
    expect(adapter.isConnected()).toBe(false);
    expect(error.message).toContain('validate CDP endpoint');
  });

  it('rejects an endpoint with credentials', async () => {
    const adapter = createBrowserAdapter({ endpoint: 'http://user:pass@127.0.0.1:9222' });
    await expectAdapterError(() => adapter.connect(), 'endpoint_forbidden');
  });

  it('reports connect_failed when nothing listens on the endpoint', async () => {
    const deadPort = await findDeadPort();
    const adapter = createBrowserAdapter({
      endpoint: `http://127.0.0.1:${deadPort}`,
      connectTimeoutMs: 2000,
    });
    await expectAdapterError(() => adapter.connect(), 'connect_failed');
    expect(adapter.isConnected()).toBe(false);
  });

  it('never leaks URL paths (debugger secrets) in connect errors', async () => {
    const adapter = createBrowserAdapter({
      endpoint: 'ws://127.0.0.1:1/devtools/browser/super-secret-id',
      connectTimeoutMs: 1500,
    });
    const error = await expectAdapterError(() => adapter.connect(), 'connect_failed');
    expect(error.message).not.toContain('super-secret-id');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(
      'super-secret-id',
    );
  });

  it('honours AbortSignal during connect', async () => {
    const adapter = createBrowserAdapter({ endpoint: 'http://127.0.0.1:9222' });
    await expectAdapterError(() => adapter.connect({ signal: AbortSignal.abort() }), 'aborted');
  });
});

describe('validateLocatorSpec', () => {
  it('accepts role, label, text and css specs', () => {
    expect(() =>
      validateLocatorSpec({ kind: 'role', role: 'button', name: 'Submit' }),
    ).not.toThrow();
    expect(() => validateLocatorSpec({ kind: 'label', label: 'Username' })).not.toThrow();
    expect(() => validateLocatorSpec({ kind: 'text', text: 'Sign in' })).not.toThrow();
    expect(() =>
      validateLocatorSpec({ kind: 'css', selector: '#search-results li' }),
    ).not.toThrow();
    expect(() => validateLocatorSpec({ kind: 'css', selector: 'css=div.part' })).not.toThrow();
    // Valid CSS pseudo-classes must not be mistaken for engine prefixes.
    expect(() => validateLocatorSpec({ kind: 'css', selector: 'div:hover' })).not.toThrow();
    expect(() =>
      validateLocatorSpec({ kind: 'css', selector: 'input[type="text"]' }),
    ).not.toThrow();
  });

  it('rejects unknown kinds and empty values', () => {
    expect(() =>
      validateLocatorSpec({ kind: 'xpath' } as unknown as { kind: 'css'; selector: string }),
    ).toThrowError(LocatorSpecError);
    expect(() => validateLocatorSpec({ kind: 'css', selector: '' })).toThrowError(LocatorSpecError);
    expect(() => validateLocatorSpec({ kind: 'label', label: '' })).toThrowError(LocatorSpecError);
    expect(() => validateLocatorSpec({ kind: 'role', role: 'button', name: '' })).toThrowError(
      LocatorSpecError,
    );
  });

  it('rejects non-CSS selector engines', () => {
    for (const selector of ['xpath=//button', 'text=Submit', 'internal:role=button']) {
      expect(() => validateLocatorSpec({ kind: 'css', selector }), selector).toThrowError(
        LocatorSpecError,
      );
    }
  });

  it('enforces length limits', () => {
    expect(() => validateLocatorSpec({ kind: 'css', selector: 'x'.repeat(2001) })).toThrowError(
      LocatorSpecError,
    );
    expect(() => validateLocatorSpec({ kind: 'text', text: 'x'.repeat(501) })).toThrowError(
      LocatorSpecError,
    );
  });
});

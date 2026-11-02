/**
 * Stage 5 + Stage 6 unit tests: MCP tools over a real MCP client/server pair
 * (InMemoryTransport) with a scripted fake BrowserAdapter.
 *
 * Covers: tool discovery (names, JSON Schemas, annotations, instructions),
 * argument validation BEFORE the browser, domain allowlist enforcement,
 * password-field refusal mapping, structured errors, and the Stage 6
 * human-control machine: automatic CAPTCHA pause, blocking of every page_*
 * tool until a VERIFIED resume, the wait timeout, and the sensitive-action
 * confirmation gate.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserAdapterError,
  type AdapterStatus,
  type BrowserAdapter,
  type ChallengeScan,
  type PageInfo,
} from '../../src/browser/adapter.js';
import { createHumanGate, type HumanGate } from '../../src/human/gate.js';
import {
  createBrowserMcpServer,
  SERVER_INSTRUCTIONS,
  type BrowserMcpServerHandle,
} from '../../src/mcp/server.js';
import { createDomainPolicy } from '../../src/policy/domains.js';

const EXPECTED_TOOLS = [
  'browser_connect',
  'browser_status',
  'page_list',
  'page_open',
  'page_navigate',
  'page_close',
  'page_snapshot',
  'page_screenshot',
  'page_click',
  'page_fill',
  'page_select',
  'page_press',
  'page_wait',
  'page_extract',
  'human_required',
  'human_resume',
] as const;

const FAKE_PAGE: PageInfo = {
  pageId: 'page-1',
  contextId: 'ctx-1',
  url: 'https://allowed.test/start',
  title: 'Start',
};

function fakeStatus(overrides: Partial<AdapterStatus> = {}): AdapterStatus {
  return {
    connected: true,
    endpoint: 'http://127.0.0.1:9222',
    tabs: 1,
    contexts: 1,
    runningOperations: 0,
    queuedOperations: 0,
    limits: {
      maxTabs: 8,
      maxConcurrentOperations: 4,
      maxQueuedOperations: 16,
      operationTimeoutMs: 30_000,
    },
    ...overrides,
  };
}

const CLEAN_SCAN: ChallengeScan = {
  url: FAKE_PAGE.url,
  title: FAKE_PAGE.title,
  frameUrls: [FAKE_PAGE.url],
  visibleText: 'Hello world, a perfectly ordinary page',
};

const CHALLENGE_SCAN: ChallengeScan = {
  url: FAKE_PAGE.url,
  title: 'Security check',
  frameUrls: [FAKE_PAGE.url, 'https://www.google.com/recaptcha/api2/anchor?k=abc'],
  visibleText: 'Please confirm that you are not a robot',
};

function createFakeAdapter(overrides: Partial<BrowserAdapter> = {}): BrowserAdapter {
  const base: BrowserAdapter = {
    connect: vi.fn(async () => fakeStatus()),
    disconnect: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    status: vi.fn(() => fakeStatus()),
    listPages: vi.fn(async () => [FAKE_PAGE]),
    openPage: vi.fn(async () => FAKE_PAGE),
    closePage: vi.fn(async (params) => ({
      pageId: params.pageId,
      closed: true as const,
      remainingTabs: 2,
      url: FAKE_PAGE.url,
    })),
    navigate: vi.fn(async (params) => ({ ...FAKE_PAGE, url: params.url })),
    snapshot: vi.fn(async () => '- heading "Hello"'),
    screenshot: vi.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    selectOption: vi.fn(async () => ['de']),
    press: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
    extract: vi.fn(async () => ({
      url: FAKE_PAGE.url,
      title: FAKE_PAGE.title,
      items: ['alpha'],
      truncated: false,
    })),
    challengeScan: vi.fn(async () => CLEAN_SCAN),
    bringToFront: vi.fn(async () => {}),
    describeLocator: vi.fn(async () => ({ name: 'Search parts' })),
  };
  return { ...base, ...overrides };
}

interface Harness {
  readonly client: Client;
  readonly handle: BrowserMcpServerHandle;
  readonly adapter: BrowserAdapter;
  readonly humanGate: HumanGate;
}

const cleanups: Array<() => Promise<void>> = [];

async function setup(
  options: { adapter?: BrowserAdapter; domains?: string[]; humanGate?: HumanGate } = {},
): Promise<Harness> {
  const adapter = options.adapter ?? createFakeAdapter();
  const humanGate = options.humanGate ?? createHumanGate();
  const handle = createBrowserMcpServer({
    adapter,
    domainPolicy: createDomainPolicy(options.domains ?? ['allowed.test', 'www.allowed.test']),
    humanGate,
    version: '0.1.0',
    logger: pino({ level: 'silent' }),
  });
  const server = handle.build();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'unit-test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, handle, adapter, humanGate };
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

function structured(result: CallToolResult): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

function errorOf(result: CallToolResult): {
  code: string;
  message: string;
  retryable: boolean;
  pageId?: string;
} {
  expect(result.isError).toBe(true);
  const error = structured(result).error as {
    code: string;
    message: string;
    retryable: boolean;
    pageId?: string;
  };
  expect(error).toBeTruthy();
  return error;
}

async function expectValidationFailure(call: Promise<unknown>): Promise<void> {
  // The SDK validates arguments before the handler runs and reports failures
  // as tool error results carrying the InvalidParams (-32602) message.
  const result = (await call) as CallToolResult;
  expect(result.isError).toBe(true);
  const text = (result.content[0] as { type: string; text: string }).text;
  expect(text).toContain('-32602');
  expect(text).toContain('Input validation error');
}

describe('tool discovery', () => {
  it('lists all 16 tools', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('exposes JSON Schema inputs/outputs and side-effect annotations', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const navigate = byName.get('page_navigate');
    expect(navigate).toBeTruthy();
    const input = navigate!.inputSchema as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(input.type).toBe('object');
    expect(Object.keys(input.properties ?? {})).toEqual(
      expect.arrayContaining(['pageId', 'url', 'waitUntil', 'timeoutMs']),
    );
    expect(input.required).toEqual(expect.arrayContaining(['pageId', 'url']));
    expect(navigate!.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });

    const status = byName.get('browser_status');
    expect(status!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    // Output schemas cover BOTH outcomes: success fields plus the structured
    // `error` branch (all optional, so error results validate too).
    const output = status!.outputSchema as {
      type?: string;
      properties?: Record<string, unknown>;
    };
    expect(output.type).toBe('object');
    expect(Object.keys(output.properties ?? {})).toEqual(
      expect.arrayContaining(['connected', 'endpoint', 'tabs', 'limits', 'humanControl', 'error']),
    );
    const errorProp = (output.properties ?? {}).error as { properties?: Record<string, unknown> };
    expect(Object.keys(errorProp.properties ?? {})).toEqual(
      expect.arrayContaining(['code', 'message', 'retryable']),
    );

    // Read-only vs acting tools are annotated consistently.
    for (const name of ['page_snapshot', 'page_screenshot', 'page_extract', 'page_wait']) {
      expect(byName.get(name)!.annotations?.readOnlyHint).toBe(true);
    }
    for (const name of ['page_click', 'page_fill', 'page_press', 'page_open']) {
      expect(byName.get(name)!.annotations?.readOnlyHint).toBe(false);
      expect(byName.get(name)!.annotations?.openWorldHint).toBe(true);
    }

    // The locator union reaches the JSON Schema with all four kinds.
    const click = byName.get('page_click');
    expect(JSON.stringify(click!.inputSchema)).toContain('"role"');
    expect(JSON.stringify(click!.inputSchema)).toContain('"css"');
  });

  it('sends security instructions at initialization', async () => {
    const { client } = await setup();
    const instructions = client.getInstructions();
    expect(instructions).toBe(SERVER_INSTRUCTIONS);
    expect(instructions).toContain('NEVER try to solve a CAPTCHA');
    expect(instructions).toContain('Domain allowlist');
    const version = client.getServerVersion();
    expect(version?.name).toBe('browser-mcp');
  });
});

describe('argument validation happens before the browser', () => {
  it('rejects malformed arguments without touching the adapter', async () => {
    const adapter = createFakeAdapter();
    const { client } = await setup({ adapter });

    await expectValidationFailure(
      client.callTool({ name: 'page_navigate', arguments: { pageId: 'page-1', url: 123 } }),
    );
    await expectValidationFailure(
      client.callTool({ name: 'page_navigate', arguments: { url: 'x' } }),
    );
    await expectValidationFailure(
      client.callTool({
        name: 'page_click',
        arguments: { pageId: 'page-1', locator: { kind: 'xpath', selector: '//div' } },
      }),
    );
    await expectValidationFailure(
      client.callTool({
        name: 'page_click',
        arguments: { pageId: 'page-1', locator: { kind: 'role', role: 'not-a-role' } },
      }),
    );
    await expectValidationFailure(
      client.callTool({
        name: 'page_fill',
        arguments: { pageId: 'page-1', locator: { kind: 'css', selector: '#x' } },
      }),
    );
    // page_select requires one of values/label/index (schema refinement).
    await expectValidationFailure(
      client.callTool({
        name: 'page_select',
        arguments: { pageId: 'page-1', locator: { kind: 'css', selector: '#s' } },
      }),
    );
    // page_wait requires locator or loadState (schema refinement).
    await expectValidationFailure(
      client.callTool({ name: 'page_wait', arguments: { pageId: 'page-1' } }),
    );
    await expectValidationFailure(
      client.callTool({ name: 'page_press', arguments: { pageId: 'page-1', key: 'has space' } }),
    );

    expect(adapter.navigate).not.toHaveBeenCalled();
    expect(adapter.click).not.toHaveBeenCalled();
    expect(adapter.fill).not.toHaveBeenCalled();
    expect(adapter.selectOption).not.toHaveBeenCalled();
    expect(adapter.wait).not.toHaveBeenCalled();
    expect(adapter.press).not.toHaveBeenCalled();
  });
});

describe('domain allowlist', () => {
  it('blocks page_navigate to forbidden domains before the browser', async () => {
    const adapter = createFakeAdapter();
    const { client } = await setup({ adapter });

    const result = (await client.callTool({
      name: 'page_navigate',
      arguments: { pageId: 'page-1', url: 'https://evil.example/' },
    })) as CallToolResult;
    const error = errorOf(result);
    expect(error.code).toBe('domain_forbidden');
    expect(error.retryable).toBe(false);
    expect(adapter.navigate).not.toHaveBeenCalled();
  });

  it('blocks page_open with a forbidden url before the browser', async () => {
    const adapter = createFakeAdapter();
    const { client } = await setup({ adapter });

    const result = (await client.callTool({
      name: 'page_open',
      arguments: { url: 'https://evil.example/' },
    })) as CallToolResult;
    expect(errorOf(result).code).toBe('domain_forbidden');
    expect(adapter.openPage).not.toHaveBeenCalled();
  });

  it('lets allowlisted urls through to the adapter', async () => {
    const adapter = createFakeAdapter();
    const { client } = await setup({ adapter });

    const result = (await client.callTool({
      name: 'page_navigate',
      arguments: { pageId: 'page-1', url: 'https://allowed.test/catalog?q=1' },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(structured(result).url).toBe('https://allowed.test/catalog?q=1');
    expect(adapter.navigate).toHaveBeenCalledTimes(1);
  });
});

describe('structured errors', () => {
  it('maps adapter errors to structured, typed results', async () => {
    const adapter = createFakeAdapter({
      snapshot: vi.fn(async () => {
        throw new BrowserAdapterError(
          'not_connected',
          'Adapter is not connected; call connect() first',
        );
      }),
    });
    const { client } = await setup({ adapter });

    const result = (await client.callTool({
      name: 'page_snapshot',
      arguments: { pageId: 'page-1' },
    })) as CallToolResult;
    const error = errorOf(result);
    expect(error.code).toBe('not_connected');
    expect(error.retryable).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text' });
  });

  it('maps password-field refusal from the adapter', async () => {
    const adapter = createFakeAdapter({
      fill: vi.fn(async () => {
        throw new BrowserAdapterError(
          'sensitive_field_forbidden',
          'fill is forbidden for password fields; the user types secrets manually',
        );
      }),
    });
    const { client } = await setup({ adapter });

    const result = (await client.callTool({
      name: 'page_fill',
      arguments: {
        pageId: 'page-1',
        locator: { kind: 'label', label: 'Password' },
        value: 'hunter2',
      },
    })) as CallToolResult;
    const error = errorOf(result);
    expect(error.code).toBe('sensitive_field_forbidden');
    expect(error.retryable).toBe(false);
    // The attempted value must never appear in the error result.
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('never leaks URL paths from unexpected errors', async () => {
    const adapter = createFakeAdapter({
      click: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED ws://127.0.0.1:9222/devtools/page/SECRETID');
      }),
    });
    const { client } = await setup({ adapter });

    const result = (await client.callTool({
      name: 'page_click',
      arguments: { pageId: 'page-1', locator: { kind: 'css', selector: '#x' } },
    })) as CallToolResult;
    const error = errorOf(result);
    expect(error.code).toBe('internal_error');
    expect(error.message).not.toContain('SECRETID');
    expect(error.message).toContain('[REDACTED]');
  });
});

describe('tool behaviour', () => {
  it('browser_connect returns the status with human-control state', async () => {
    const { client } = await setup();
    const result = (await client.callTool({
      name: 'browser_connect',
      arguments: {},
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const status = structured(result);
    expect(status.connected).toBe(true);
    expect(status.humanControl).toEqual({ state: 'ready' });
  });

  it('page_screenshot returns an image block plus metadata only', async () => {
    const { client } = await setup();
    const result = (await client.callTool({
      name: 'page_screenshot',
      arguments: { pageId: 'page-1' },
    })) as CallToolResult;
    const block = result.content[0] as { type: string; data?: string; mimeType?: string };
    expect(block.type).toBe('image');
    expect(block.mimeType).toBe('image/png');
    expect(block.data).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));
    expect(structured(result)).toEqual({
      pageId: 'page-1',
      mimeType: 'image/png',
      sizeBytes: 4,
      fullPage: false,
    });
  });

  it('page_fill never echoes the value back', async () => {
    const { client } = await setup();
    const result = (await client.callTool({
      name: 'page_fill',
      arguments: {
        pageId: 'page-1',
        locator: { kind: 'label', label: 'Username' },
        value: 'top-secret-value',
      },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(structured(result).filled).toBe(true);
    expect(JSON.stringify(result)).not.toContain('top-secret-value');
  });

  it('page_list returns tab infos', async () => {
    const { client } = await setup();
    const result = (await client.callTool({ name: 'page_list', arguments: {} })) as CallToolResult;
    expect(structured(result).pages).toEqual([
      {
        pageId: 'page-1',
        contextId: 'ctx-1',
        url: FAKE_PAGE.url,
        title: FAKE_PAGE.title,
        openedByAdapter: false,
      },
    ]);
  });

  it('page_list flags the tabs the automation opened itself', async () => {
    const adapter = createFakeAdapter({
      listPages: vi.fn(async () => [{ ...FAKE_PAGE, openedByAdapter: true }]),
    });
    const { client } = await setup({ adapter });
    const result = (await client.callTool({ name: 'page_list', arguments: {} })) as CallToolResult;
    expect(structured(result).pages).toMatchObject([{ pageId: 'page-1', openedByAdapter: true }]);
  });
});

describe('human-control: manual handover (human_required / human_resume)', () => {
  it('human_required pauses automation and reports the hostname', async () => {
    const adapter = createFakeAdapter();
    const { client } = await setup({ adapter });
    const result = (await client.callTool({
      name: 'human_required',
      arguments: { reason: 'CAPTCHA detected', pageId: 'page-1' },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const out = structured(result);
    expect(out.paused).toBe(true);
    expect(out.state).toBe('waiting_for_user');
    expect(out.reason).toBe('CAPTCHA detected');
    expect(out.hostname).toBe('allowed.test');
    expect(out.kind).toBe('manual');
    expect(out.timeoutAt).toBeTruthy();
    // The tab is brought to the front so the user can see it.
    expect(adapter.bringToFront).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: 'page-1' }),
    );
  });

  it('blocks ALL page_* tools (including reads) until human_resume', async () => {
    const adapter = createFakeAdapter();
    const { client } = await setup({ adapter });

    await client.callTool({
      name: 'human_required',
      arguments: { reason: 'login required', pageId: 'page-1' },
    });

    const blocked: Array<[string, Record<string, unknown>]> = [
      ['page_list', {}],
      ['page_open', {}],
      ['page_navigate', { pageId: 'page-1', url: 'https://allowed.test/' }],
      ['page_snapshot', { pageId: 'page-1' }],
      ['page_screenshot', { pageId: 'page-1' }],
      ['page_click', { pageId: 'page-1', locator: { kind: 'css', selector: '#x' } }],
      ['page_fill', { pageId: 'page-1', locator: { kind: 'css', selector: '#x' }, value: 'v' }],
      ['page_select', { pageId: 'page-1', locator: { kind: 'css', selector: '#x' }, label: 'L' }],
      ['page_press', { pageId: 'page-1', key: 'Enter' }],
      ['page_wait', { pageId: 'page-1', loadState: 'load' }],
      ['page_extract', { pageId: 'page-1' }],
    ];
    for (const [name, args] of blocked) {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const error = errorOf(result);
      expect(error.code, name).toBe('human_required');
      expect(error.pageId, name).toBe('page-1');
    }

    // Nothing reached the browser while paused. (`listPages` ran exactly once:
    // the best-effort hostname lookup inside human_required itself.)
    expect(adapter.listPages).toHaveBeenCalledTimes(1);
    expect(adapter.openPage).not.toHaveBeenCalled();
    expect(adapter.navigate).not.toHaveBeenCalled();
    expect(adapter.snapshot).not.toHaveBeenCalled();
    expect(adapter.screenshot).not.toHaveBeenCalled();
    expect(adapter.click).not.toHaveBeenCalled();
    expect(adapter.fill).not.toHaveBeenCalled();
    expect(adapter.selectOption).not.toHaveBeenCalled();
    expect(adapter.press).not.toHaveBeenCalled();
    expect(adapter.wait).not.toHaveBeenCalled();
    expect(adapter.extract).not.toHaveBeenCalled();

    // Status stays available and reflects the pause.
    const status = (await client.callTool({
      name: 'browser_status',
      arguments: {},
    })) as CallToolResult;
    expect(structured(status).humanControl).toMatchObject({
      state: 'waiting_for_user',
      reason: 'login required',
      pageId: 'page-1',
      kind: 'manual',
    });

    // Resume unblocks the tools; automation continues on the SAME tab.
    const resumed = (await client.callTool({
      name: 'human_resume',
      arguments: {},
    })) as CallToolResult;
    expect(structured(resumed).resumed).toBe(true);
    expect((structured(resumed).status as Record<string, unknown>).humanControl).toEqual({
      state: 'ready',
    });

    const after = (await client.callTool({
      name: 'page_snapshot',
      arguments: { pageId: 'page-1' },
    })) as CallToolResult;
    expect(after.isError).toBeFalsy();
    expect(adapter.snapshot).toHaveBeenCalledTimes(1);
  });

  it('human_resume is idempotent when nothing is paused', async () => {
    const { client } = await setup();
    const result = (await client.callTool({
      name: 'human_resume',
      arguments: {},
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(structured(result)).toMatchObject({ resumed: true, state: 'ready' });
  });

  it('a manual pause does not re-scan on resume (no challenge kind)', async () => {
    const adapter = createFakeAdapter();
    const { client } = await setup({ adapter });
    await client.callTool({
      name: 'human_required',
      arguments: { reason: 'login', pageId: 'page-1' },
    });
    const resumed = (await client.callTool({
      name: 'human_resume',
      arguments: {},
    })) as CallToolResult;
    expect(resumed.isError).toBeFalsy();
    expect(adapter.challengeScan).not.toHaveBeenCalled();
  });
});

describe('human-control: automatic CAPTCHA detection (Stage 6)', () => {
  it('page_navigate pauses automation on a detected challenge and keeps the tab visible', async () => {
    const adapter = createFakeAdapter({
      challengeScan: vi.fn(async () => CHALLENGE_SCAN),
    });
    const { client, humanGate } = await setup({ adapter });

    const result = (await client.callTool({
      name: 'page_navigate',
      arguments: { pageId: 'page-1', url: 'https://allowed.test/catalog' },
    })) as CallToolResult;

    // The navigation happened, but the result reports the challenge:
    // pageId + hostname + a safe explanation (no page content, no URL paths).
    const error = errorOf(result);
    expect(error.code).toBe('captcha_detected');
    expect(error.retryable).toBe(false);
    expect(error.pageId).toBe('page-1');
    expect(error.message).toContain('reCAPTCHA');
    expect(error.message).toContain('allowed.test');
    expect(error.message).not.toContain('/recaptcha');
    expect(error.message).not.toContain('k=abc');

    // The machine paused in human_required and the tab was activated.
    expect(humanGate.snapshot()).toMatchObject({
      state: 'human_required',
      pageId: 'page-1',
      kind: 'challenge',
      hostname: 'allowed.test',
      provider: 'reCAPTCHA',
    });
    expect(adapter.bringToFront).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: 'page-1' }),
    );
  });

  it('page_open, page_click and page_press also scan; read-only tools do not', async () => {
    const adapter = createFakeAdapter();
    const { client } = await setup({ adapter });

    await client.callTool({ name: 'page_open', arguments: {} });
    await client.callTool({
      name: 'page_click',
      arguments: { pageId: 'page-1', locator: { kind: 'css', selector: '#x' } },
    });
    await client.callTool({ name: 'page_press', arguments: { pageId: 'page-1', key: 'Enter' } });
    expect(adapter.challengeScan).toHaveBeenCalledTimes(3);

    await client.callTool({ name: 'page_snapshot', arguments: { pageId: 'page-1' } });
    await client.callTool({ name: 'page_extract', arguments: { pageId: 'page-1' } });
    await client.callTool({ name: 'page_screenshot', arguments: { pageId: 'page-1' } });
    await client.callTool({ name: 'page_list', arguments: {} });
    expect(adapter.challengeScan).toHaveBeenCalledTimes(3);
  });

  it('human_resume verifies the challenge is gone before releasing automation', async () => {
    const scan = vi.fn<() => Promise<ChallengeScan>>(async () => CHALLENGE_SCAN);
    const adapter = createFakeAdapter({ challengeScan: scan });
    const { client, humanGate } = await setup({ adapter });

    // Navigate triggers the challenge pause.
    await client.callTool({
      name: 'page_navigate',
      arguments: { pageId: 'page-1', url: 'https://allowed.test/catalog' },
    });
    expect(humanGate.state()).toBe('human_required');

    // First resume attempt: the challenge is still on screen -> rejected,
    // automation stays paused (waiting_for_user).
    const rejected = (await client.callTool({
      name: 'human_resume',
      arguments: {},
    })) as CallToolResult;
    const error = errorOf(rejected);
    expect(error.code).toBe('challenge_still_present');
    expect(error.retryable).toBe(true);
    expect(error.pageId).toBe('page-1');
    expect(humanGate.state()).toBe('waiting_for_user');

    // Tools remain blocked while the wait continues.
    const stillBlocked = (await client.callTool({
      name: 'page_snapshot',
      arguments: { pageId: 'page-1' },
    })) as CallToolResult;
    expect(errorOf(stillBlocked).code).toBe('human_required');

    // The user solves the challenge in the visible Chrome: the page no longer
    // carries challenge signals. Resume now succeeds on the SAME tab.
    scan.mockImplementation(async () => CLEAN_SCAN);
    const resumed = (await client.callTool({
      name: 'human_resume',
      arguments: {},
    })) as CallToolResult;
    expect(resumed.isError).toBeFalsy();
    expect(structured(resumed).resumed).toBe(true);
    expect(humanGate.state()).toBe('ready');

    const after = (await client.callTool({
      name: 'page_snapshot',
      arguments: { pageId: 'page-1' },
    })) as CallToolResult;
    expect(after.isError).toBeFalsy();
    expect(adapter.snapshot).toHaveBeenCalledTimes(1);
  });

  it('resume proceeds when the challenged tab was closed by the user', async () => {
    const scan = vi.fn<() => Promise<ChallengeScan>>(async () => CHALLENGE_SCAN);
    const adapter = createFakeAdapter({ challengeScan: scan });
    const { client, humanGate } = await setup({ adapter });

    await client.callTool({
      name: 'page_navigate',
      arguments: { pageId: 'page-1', url: 'https://allowed.test/catalog' },
    });
    // The user closes the challenged tab; the scan can no longer run.
    scan.mockImplementation(async () => {
      throw new BrowserAdapterError('page_closed', 'Tab "page-1" is closed');
    });
    const resumed = (await client.callTool({
      name: 'human_resume',
      arguments: {},
    })) as CallToolResult;
    expect(resumed.isError).toBeFalsy();
    expect(humanGate.state()).toBe('ready');
  });

  it('a scan failure never breaks the triggering operation', async () => {
    const adapter = createFakeAdapter({
      challengeScan: vi.fn(async () => {
        throw new BrowserAdapterError('timeout', 'challengeScan timed out');
      }),
    });
    const { client, humanGate } = await setup({ adapter });
    const result = (await client.callTool({
      name: 'page_navigate',
      arguments: { pageId: 'page-1', url: 'https://allowed.test/catalog' },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(structured(result).url).toBe('https://allowed.test/catalog');
    expect(humanGate.state()).toBe('ready');
  });

  it('challenge scan content never leaks into results', async () => {
    const adapter = createFakeAdapter({
      challengeScan: vi.fn(async () => ({
        ...CHALLENGE_SCAN,
        visibleText: 'SECRET-PAGE-TEXT i am not a robot',
        frameUrls: ['https://www.google.com/recaptcha/api2/anchor?k=SECRETTOKEN'],
      })),
    });
    const { client } = await setup({ adapter });
    const result = (await client.callTool({
      name: 'page_navigate',
      arguments: { pageId: 'page-1', url: 'https://allowed.test/catalog' },
    })) as CallToolResult;
    const raw = JSON.stringify(result);
    expect(raw).not.toContain('SECRET-PAGE-TEXT');
    expect(raw).not.toContain('SECRETTOKEN');
  });
});

describe('human-control: wait timeout (Stage 6)', () => {
  it('a timed-out wait fails itself and blocks with human_timeout', async () => {
    const adapter = createFakeAdapter();
    const humanGate = createHumanGate({ timeoutMs: 30 });
    const { client } = await setup({ adapter, humanGate });

    await client.callTool({
      name: 'human_required',
      arguments: { reason: 'login required', pageId: 'page-1' },
    });
    await vi.waitFor(() => expect(humanGate.state()).toBe('failed'));

    const blocked = (await client.callTool({
      name: 'page_snapshot',
      arguments: { pageId: 'page-1' },
    })) as CallToolResult;
    const error = errorOf(blocked);
    expect(error.code).toBe('human_timeout');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('timed out');

    // Status reports the failed state.
    const status = (await client.callTool({
      name: 'browser_status',
      arguments: {},
    })) as CallToolResult;
    expect(structured(status).humanControl).toMatchObject({ state: 'failed' });

    // A fresh human_required starts a new wait round...
    const again = (await client.callTool({
      name: 'human_required',
      arguments: { reason: 'second attempt', pageId: 'page-1' },
    })) as CallToolResult;
    expect(structured(again).state).toBe('waiting_for_user');

    // ...and human_resume releases automation.
    const resumed = (await client.callTool({
      name: 'human_resume',
      arguments: {},
    })) as CallToolResult;
    expect(resumed.isError).toBeFalsy();
    expect(humanGate.state()).toBe('ready');
  });
});

describe('sensitive-action confirmation (Stage 6)', () => {
  it('refuses a purchase click until the user confirms with the token', async () => {
    const adapter = createFakeAdapter({
      describeLocator: vi.fn(async () => ({ name: 'Jetzt kaufen' })),
    });
    const { client } = await setup({ adapter });

    const refused = (await client.callTool({
      name: 'page_click',
      arguments: {
        pageId: 'page-1',
        locator: { kind: 'role', role: 'button', name: 'Jetzt kaufen' },
      },
    })) as CallToolResult;
    const error = errorOf(refused);
    expect(error.code).toBe('confirmation_required');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('purchase/payment');
    expect(error.message).toContain('Jetzt kaufen');
    const out = structured(refused);
    const token = out.confirmToken as string;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(out.sensitiveAction).toBe('purchase');
    expect(adapter.click).not.toHaveBeenCalled();

    // With the token (user approved) the SAME click executes.
    const confirmed = (await client.callTool({
      name: 'page_click',
      arguments: {
        pageId: 'page-1',
        locator: { kind: 'role', role: 'button', name: 'Jetzt kaufen' },
        confirmToken: token,
      },
    })) as CallToolResult;
    expect(confirmed.isError).toBeFalsy();
    expect(structured(confirmed).clicked).toBe(true);
    expect(adapter.click).toHaveBeenCalledTimes(1);

    // The token was single-use.
    const replayed = (await client.callTool({
      name: 'page_click',
      arguments: {
        pageId: 'page-1',
        locator: { kind: 'role', role: 'button', name: 'Jetzt kaufen' },
        confirmToken: token,
      },
    })) as CallToolResult;
    expect(errorOf(replayed).code).toBe('confirmation_required');
    expect(adapter.click).toHaveBeenCalledTimes(1);
  });

  it('classifies messages and account changes too', async () => {
    const adapter = createFakeAdapter({
      describeLocator: vi.fn(async () => ({ name: 'Отправить сообщение' })),
    });
    const { client } = await setup({ adapter });
    const refused = (await client.callTool({
      name: 'page_click',
      arguments: { pageId: 'page-1', locator: { kind: 'css', selector: '#send' } },
    })) as CallToolResult;
    expect(structured(refused).sensitiveAction).toBe('message');

    const accountAdapter = createFakeAdapter({
      describeLocator: vi.fn(async () => ({ name: 'Delete account' })),
    });
    const account = await setup({ adapter: accountAdapter });
    const refusedAccount = (await account.client.callTool({
      name: 'page_click',
      arguments: { pageId: 'page-1', locator: { kind: 'css', selector: '#del' } },
    })) as CallToolResult;
    expect(structured(refusedAccount).sensitiveAction).toBe('account_change');
  });

  it('lets harmless clicks through without a token', async () => {
    const adapter = createFakeAdapter({
      describeLocator: vi.fn(async () => ({ name: 'Search parts' })),
    });
    const { client } = await setup({ adapter });
    const result = (await client.callTool({
      name: 'page_click',
      arguments: { pageId: 'page-1', locator: { kind: 'css', selector: '#search' } },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(structured(result).clicked).toBe(true);
    expect(adapter.click).toHaveBeenCalledTimes(1);
  });

  it('rejects a token issued for another page', async () => {
    const adapter = createFakeAdapter({
      describeLocator: vi.fn(async () => ({ name: 'Buy now' })),
    });
    const { client } = await setup({ adapter });
    const refused = (await client.callTool({
      name: 'page_click',
      arguments: { pageId: 'page-1', locator: { kind: 'css', selector: '#buy' } },
    })) as CallToolResult;
    const token = structured(refused).confirmToken as string;

    const wrongPage = (await client.callTool({
      name: 'page_click',
      arguments: {
        pageId: 'page-2',
        locator: { kind: 'css', selector: '#buy' },
        confirmToken: token,
      },
    })) as CallToolResult;
    expect(errorOf(wrongPage).code).toBe('confirmation_required');
    expect(adapter.click).not.toHaveBeenCalled();
  });

  it('a describe failure with a token fails the click (no silent bypass)', async () => {
    const adapter = createFakeAdapter({
      describeLocator: vi.fn(async () => {
        throw new BrowserAdapterError('timeout', 'describeLocator timed out');
      }),
    });
    const { client } = await setup({ adapter });
    const result = (await client.callTool({
      name: 'page_click',
      arguments: {
        pageId: 'page-1',
        locator: { kind: 'css', selector: '#buy' },
        confirmToken: 'f'.repeat(32),
      },
    })) as CallToolResult;
    expect(errorOf(result).code).toBe('timeout');
    expect(adapter.click).not.toHaveBeenCalled();
  });

  it('a describe failure without a token still attempts the click', async () => {
    const adapter = createFakeAdapter({
      describeLocator: vi.fn(async () => {
        throw new BrowserAdapterError('timeout', 'describeLocator timed out');
      }),
    });
    const { client } = await setup({ adapter });
    const result = (await client.callTool({
      name: 'page_click',
      arguments: { pageId: 'page-1', locator: { kind: 'css', selector: '#ok' } },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(adapter.click).toHaveBeenCalledTimes(1);
  });
});

describe('page_close', () => {
  const OWNED_PAGE: PageInfo = { ...FAKE_PAGE, openedByAdapter: true };
  const USER_PAGE: PageInfo = {
    pageId: 'page-2',
    contextId: 'ctx-1',
    url: 'https://allowed.test/profile/orders',
    title: 'Account',
    openedByAdapter: false,
  };

  it('closes a tab the automation opened without any confirmation', async () => {
    const adapter = createFakeAdapter({ listPages: vi.fn(async () => [OWNED_PAGE, USER_PAGE]) });
    const { client } = await setup({ adapter });

    const result = (await client.callTool({
      name: 'page_close',
      arguments: { pageId: 'page-1' },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(structured(result)).toMatchObject({
      pageId: 'page-1',
      closed: true,
      remainingTabs: 2,
      url: FAKE_PAGE.url,
    });
    expect(adapter.closePage).toHaveBeenCalledTimes(1);
    expect(adapter.closePage).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: 'page-1' }),
    );
  });

  it('refuses to close a tab the USER opened until the token is presented', async () => {
    const adapter = createFakeAdapter({ listPages: vi.fn(async () => [USER_PAGE]) });
    const { client } = await setup({ adapter });

    const refused = (await client.callTool({
      name: 'page_close',
      arguments: { pageId: 'page-2' },
    })) as CallToolResult;

    const error = errorOf(refused);
    expect(error.code).toBe('confirmation_required');
    expect(error.retryable).toBe(true);
    expect(error.pageId).toBe('page-2');
    expect(error.message).toContain('allowed.test');
    const token = structured(refused).confirmToken as string;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(structured(refused).sensitiveAction).toBe('tab_close');
    // Nothing was closed on the refusal path.
    expect(adapter.closePage).not.toHaveBeenCalled();

    // The user approved: the identical call with the token closes the tab.
    const confirmed = (await client.callTool({
      name: 'page_close',
      arguments: { pageId: 'page-2', confirmToken: token },
    })) as CallToolResult;
    expect(confirmed.isError).toBeFalsy();
    expect(structured(confirmed).closed).toBe(true);
    expect(adapter.closePage).toHaveBeenCalledTimes(1);

    // Single-use: replaying the token asks again.
    const replayed = (await client.callTool({
      name: 'page_close',
      arguments: { pageId: 'page-2', confirmToken: token },
    })) as CallToolResult;
    expect(errorOf(replayed).code).toBe('confirmation_required');
    expect(adapter.closePage).toHaveBeenCalledTimes(1);
  });

  it('rejects a token issued for another tab', async () => {
    const adapter = createFakeAdapter({ listPages: vi.fn(async () => [OWNED_PAGE, USER_PAGE]) });
    const { client } = await setup({ adapter });
    const refused = (await client.callTool({
      name: 'page_close',
      arguments: { pageId: 'page-2' },
    })) as CallToolResult;
    const token = structured(refused).confirmToken as string;

    const wrongTab = (await client.callTool({
      name: 'page_close',
      arguments: { pageId: 'page-3', confirmToken: token },
    })) as CallToolResult;
    expect(errorOf(wrongTab).code).toBe('unknown_page');
    expect(adapter.closePage).not.toHaveBeenCalled();
  });

  it('reports an unknown pageId without touching the adapter', async () => {
    const adapter = createFakeAdapter({ listPages: vi.fn(async () => [OWNED_PAGE]) });
    const { client } = await setup({ adapter });

    const result = (await client.callTool({
      name: 'page_close',
      arguments: { pageId: 'page-99' },
    })) as CallToolResult;
    const error = errorOf(result);
    expect(error.code).toBe('unknown_page');
    expect(error.retryable).toBe(false);
    expect(adapter.closePage).not.toHaveBeenCalled();
  });

  it('surfaces the last-tab refusal from the adapter', async () => {
    const adapter = createFakeAdapter({
      listPages: vi.fn(async () => [OWNED_PAGE]),
      closePage: vi.fn(async () => {
        throw new BrowserAdapterError(
          'last_tab_forbidden',
          'Refusing to close the only open tab: Chrome exits when its last tab closes',
        );
      }),
    });
    const { client } = await setup({ adapter });

    const result = (await client.callTool({
      name: 'page_close',
      arguments: { pageId: 'page-1' },
    })) as CallToolResult;
    const error = errorOf(result);
    expect(error.code).toBe('last_tab_forbidden');
    expect(error.retryable).toBe(false);
  });

  it('is blocked while human control is paused', async () => {
    const { client, humanGate } = await setup();
    humanGate.pause({ reason: 'login', pageId: 'page-1', kind: 'manual' });

    const result = (await client.callTool({
      name: 'page_close',
      arguments: { pageId: 'page-1' },
    })) as CallToolResult;
    expect(errorOf(result).code).toBe('human_required');
  });

  it('validates arguments and is advertised as destructive', async () => {
    const adapter = createFakeAdapter();
    const { client } = await setup({ adapter });

    await expectValidationFailure(client.callTool({ name: 'page_close', arguments: {} }));
    expect(adapter.closePage).not.toHaveBeenCalled();

    const { tools } = await client.listTools();
    const close = tools.find((tool) => tool.name === 'page_close');
    expect(close).toBeTruthy();
    expect(close!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
    expect(JSON.stringify(close!.inputSchema)).toContain('confirmToken');
  });
});

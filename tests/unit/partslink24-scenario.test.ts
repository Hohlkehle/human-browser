/**
 * Stage 9: Partslink24 scenario engine unit tests. A scripted fake `call`
 * plays the MCP server (no Chrome, no network): the tests prove the flow
 * logic — login handover, CAPTCHA handover with verified resume, session
 * continuity, extraction scope, VIN masking, and that purchases are never
 * confirmed.
 */
import { describe, expect, it } from 'vitest';
import {
  detectLoginWall,
  formatScenarioReport,
  runPartslink24Scenario,
  type Partslink24Script,
  type ScenarioHandoff,
  type ScenarioToolCall,
  type ScenarioToolResult,
} from '../../src/scenarios/partslink24.js';

const VIN = 'WVWZZZ1KZAW123456';
const VIN_MASKED = 'WVW********123456';

const TEST_SCRIPT: Partslink24Script = {
  startUrl: 'https://mock.partslink24.test/',
  search: {
    vinLocator: { kind: 'label', label: 'VIN' },
    submitLocator: { kind: 'role', role: 'button', name: 'Search' },
  },
  results: {
    waitLocator: { kind: 'css', selector: '#parts' },
    partNumberLocator: { kind: 'css', selector: '#pn' },
    applicabilityLocator: { kind: 'css', selector: '#appl' },
  },
};

const LOGIN_SNAPSHOT = [
  '- heading "Sign in to Partslink24" [level=1]',
  '- textbox "Username"',
  '- textbox "Password": [REDACTED]',
  '- button "Sign in"',
].join('\n');

const CATALOG_SNAPSHOT = [
  '- heading "Vehicle search" [level=1]',
  '- textbox "VIN"',
  '- button "Search"',
].join('\n');

const CHALLENGE_SNAPSHOT = [
  '- heading "Please verify you are human" [level=1]',
  '- text: We need to confirm that you are not a robot.',
].join('\n');

function ok(structuredContent: Record<string, unknown> = {}): ScenarioToolResult {
  return { structuredContent };
}

function err(code: string, extra: Record<string, unknown> = {}): ScenarioToolResult {
  return {
    isError: true,
    structuredContent: {
      error: { code, message: `${code}: simulated`, retryable: false, ...extra },
    },
  };
}

interface RecordedCall {
  readonly tool: string;
  readonly args: Record<string, unknown> | undefined;
}

interface FakeServer {
  readonly call: ScenarioToolCall;
  readonly calls: readonly RecordedCall[];
  readonly handoffs: readonly ScenarioHandoff[];
}

interface FakeServerOptions {
  /** Start URL echoed by page_open/page_list (defaults to the test script). */
  readonly startUrl?: string;
  readonly snapshot?: (callIndex: number) => ScenarioToolResult;
  readonly open?: () => ScenarioToolResult;
  readonly fill?: (callIndex: number) => ScenarioToolResult;
  readonly click?: () => ScenarioToolResult;
  readonly wait?: (callIndex: number) => ScenarioToolResult;
  readonly resume?: (callIndex: number) => ScenarioToolResult;
  readonly status?: () => ScenarioToolResult;
  readonly extract?: (args: Record<string, unknown> | undefined) => ScenarioToolResult;
  readonly waitForUser?: (handoff: ScenarioHandoff) => void;
}

function createFakeServer(options: FakeServerOptions = {}): FakeServer {
  const calls: RecordedCall[] = [];
  const handoffs: ScenarioHandoff[] = [];
  const counters: Record<string, number> = {};

  const nextIndex = (tool: string): number => {
    counters[tool] = (counters[tool] ?? 0) + 1;
    return counters[tool] as number;
  };

  const startUrl = options.startUrl ?? TEST_SCRIPT.startUrl;

  const call: ScenarioToolCall = async (tool, args) => {
    calls.push({ tool, args });
    switch (tool) {
      case 'browser_connect':
        return ok({ connected: true });
      case 'page_open':
        return options.open ? options.open() : ok({ pageId: 'page-1', url: startUrl });
      case 'page_snapshot':
        return options.snapshot
          ? options.snapshot(nextIndex('page_snapshot'))
          : ok({ snapshot: CATALOG_SNAPSHOT });
      case 'page_fill':
        return options.fill ? options.fill(nextIndex('page_fill')) : ok({ filled: true });
      case 'page_click':
        return options.click ? options.click() : ok({ clicked: true });
      case 'page_wait':
        return options.wait ? options.wait(nextIndex('page_wait')) : ok({ waited: true });
      case 'page_extract': {
        if (options.extract) return options.extract(args);
        const selector = (args?.['locator'] as { selector?: string } | undefined)?.selector;
        if (selector === '#pn') return ok({ items: ['PN-1', 'PN-2'], truncated: false });
        if (selector === '#appl') return ok({ items: ['Car A 1.4'], truncated: false });
        return ok({ items: [], truncated: false });
      }
      case 'browser_status':
        return options.status ? options.status() : ok({ humanControl: { state: 'ready' } });
      case 'human_required':
        return ok({ paused: true, state: 'waiting_for_user' });
      case 'human_resume':
        return options.resume ? options.resume(nextIndex('human_resume')) : ok({ resumed: true });
      case 'page_list':
        return ok({ pages: [{ pageId: 'page-1', url: startUrl }] });
      default:
        return ok();
    }
  };

  return {
    call,
    calls,
    handoffs,
  };
}

async function runScenario(server: FakeServer, waitForUser?: (handoff: ScenarioHandoff) => void) {
  return await runPartslink24Scenario({
    call: server.call,
    waitForUser: async (handoff) => {
      (server.handoffs as ScenarioHandoff[]).push(handoff);
      waitForUser?.(handoff);
    },
    vin: VIN,
    script: TEST_SCRIPT,
  });
}

describe('detectLoginWall', () => {
  it('detects a password-named field', () => {
    expect(detectLoginWall(LOGIN_SNAPSHOT)).toEqual({ detected: true, marker: 'password_field' });
    expect(detectLoginWall('- textbox "Пароль": [REDACTED]')).toEqual({
      detected: true,
      marker: 'password_field',
    });
  });

  it('detects login wording without a password field', () => {
    expect(detectLoginWall('- button "Log in"')).toEqual({
      detected: true,
      marker: 'login_phrase',
    });
    expect(detectLoginWall('- link "Войти"')).toEqual({ detected: true, marker: 'login_phrase' });
  });

  it('does not fire on signed-in or unrelated pages', () => {
    expect(detectLoginWall(CATALOG_SNAPSHOT).detected).toBe(false);
    expect(detectLoginWall('- link "Sign out"').detected).toBe(false);
    expect(detectLoginWall('- text: signing documents').detected).toBe(false);
    expect(detectLoginWall('- link "Выйти"').detected).toBe(false);
  });
});

describe('runPartslink24Scenario', () => {
  it('runs the happy path without handoffs and extracts only part numbers + applicability', async () => {
    const server = createFakeServer();
    const report = await runScenario(server);

    expect(report.ok).toBe(true);
    expect(report.handoffs).toEqual([]);
    expect(report.pageId).toBe('page-1');
    expect(report.hostname).toBe('mock.partslink24.test');
    expect(report.partNumbers).toEqual(['PN-1', 'PN-2']);
    expect(report.applicability).toEqual(['Car A 1.4']);
    expect(report.vinMasked).toBe(VIN_MASKED);

    const tools = server.calls.map((entry) => entry.tool);
    expect(tools).toEqual([
      'browser_connect',
      'page_open',
      'page_snapshot',
      'page_fill',
      'page_click',
      'browser_status',
      'page_wait',
      'page_extract',
      'page_extract',
    ]);

    // The VIN reaches ONLY page_fill; no other call carries it.
    const fill = server.calls.find((entry) => entry.tool === 'page_fill');
    expect(fill?.args?.['value']).toBe(VIN);
    for (const entry of server.calls) {
      if (entry.tool === 'page_fill') continue;
      expect(JSON.stringify(entry.args ?? {})).not.toContain(VIN);
    }
  });

  it('drives the same site-independent flow with a Partsouq script', async () => {
    // MVP criterion "a working Partslink24/Partsouq test": the engine flow is
    // site-independent (locators are injected), and partsouq.com is on the
    // default domain allowlist (src/config/schema.ts). Real Partsouq locators
    // are best-effort like Partslink24's and get re-derived via page_snapshot.
    const partsouqScript: Partslink24Script = {
      startUrl: 'https://www.partsouq.com/',
      search: {
        vinLocator: { kind: 'label', label: 'VIN' },
        submitLocator: { kind: 'role', role: 'button', name: 'Search' },
      },
      results: {
        waitLocator: { kind: 'css', selector: '#parts' },
        partNumberLocator: { kind: 'css', selector: '#pn' },
        applicabilityLocator: { kind: 'css', selector: '#appl' },
      },
    };
    const server = createFakeServer({ startUrl: partsouqScript.startUrl });
    const report = await runPartslink24Scenario({
      call: server.call,
      waitForUser: async (handoff) => {
        (server.handoffs as ScenarioHandoff[]).push(handoff);
      },
      vin: VIN,
      script: partsouqScript,
    });

    expect(report.ok).toBe(true);
    expect(report.hostname).toBe('www.partsouq.com');
    expect(report.partNumbers).toEqual(['PN-1', 'PN-2']);
    expect(report.applicability).toEqual(['Car A 1.4']);
    const open = server.calls.find((entry) => entry.tool === 'page_open');
    expect(open?.args?.['url']).toBe('https://www.partsouq.com/');
  });

  it('hands over on a login wall and continues the SAME tab after resume', async () => {
    const server = createFakeServer({
      snapshot: (index) => ok({ snapshot: index === 1 ? LOGIN_SNAPSHOT : CATALOG_SNAPSHOT }),
    });
    const report = await runScenario(server);

    expect(report.ok).toBe(true);
    expect(report.handoffs).toEqual([{ kind: 'login', pageId: 'page-1', rounds: 1 }]);
    expect(server.handoffs).toHaveLength(1);
    expect(server.handoffs[0]?.kind).toBe('login');
    // Safe reason: hostname only, never page content.
    expect(server.handoffs[0]?.reason).toContain('mock.partslink24.test');
    expect(server.handoffs[0]?.reason).not.toContain('Password');

    // human_required paused with the pageId, then human_resume continued.
    const pause = server.calls.find((entry) => entry.tool === 'human_required');
    expect(pause?.args?.['pageId']).toBe('page-1');
    const resumeIndex = server.calls.findIndex((entry) => entry.tool === 'human_resume');
    expect(resumeIndex).toBeGreaterThan(server.calls.findIndex((e) => e.tool === 'human_required'));
    // No second tab was opened: exactly one page_open in the whole run.
    expect(server.calls.filter((entry) => entry.tool === 'page_open')).toHaveLength(1);
  });

  it('hands over when page_open itself hits a challenge', async () => {
    const server = createFakeServer({
      open: () => err('captcha_detected', { pageId: 'page-1' }),
    });
    const report = await runScenario(server);

    expect(report.ok).toBe(true);
    expect(report.handoffs).toEqual([{ kind: 'challenge', pageId: 'page-1', rounds: 1 }]);
    expect(report.pageId).toBe('page-1');
  });

  it('hands over when the search click triggers a CAPTCHA', async () => {
    const server = createFakeServer({
      click: () => err('captcha_detected', { pageId: 'page-1' }),
    });
    const report = await runScenario(server);

    expect(report.ok).toBe(true);
    expect(report.handoffs).toEqual([{ kind: 'challenge', pageId: 'page-1', rounds: 1 }]);
    // After the handoff the wait/extract steps still ran on the same tab.
    const tools = server.calls.map((entry) => entry.tool);
    expect(tools.indexOf('human_resume')).toBeLessThan(tools.lastIndexOf('page_wait'));
  });

  it('keeps waiting while the challenge is still present (verified resume)', async () => {
    const server = createFakeServer({
      click: () => err('captcha_detected', { pageId: 'page-1' }),
      resume: (index) => (index === 1 ? err('challenge_still_present') : ok({ resumed: true })),
    });
    const report = await runScenario(server);

    expect(report.ok).toBe(true);
    expect(report.handoffs).toEqual([{ kind: 'challenge', pageId: 'page-1', rounds: 2 }]);
    expect(server.handoffs.map((handoff) => handoff.attempt)).toEqual([1, 2]);
  });

  it('fails when the login wall survives every handover round', async () => {
    const server = createFakeServer({
      snapshot: () => ok({ snapshot: LOGIN_SNAPSHOT }),
    });
    const report = await runScenario(server, () => {});

    expect(report.ok).toBe(false);
    expect(report.errorCode).toBe('login_not_completed');
    expect(report.handoffs).toHaveLength(3);
    expect(report.handoffs.every((handoff) => handoff.kind === 'login')).toBe(true);
  });

  it('never confirms a sensitive action', async () => {
    const server = createFakeServer({
      click: () => err('confirmation_required', { confirmToken: 'token-1' }),
    });
    const report = await runScenario(server);

    expect(report.ok).toBe(false);
    expect(report.errorCode).toBe('sensitive_action_forbidden');
    // No call ever carried a confirmToken.
    for (const entry of server.calls) {
      expect(JSON.stringify(entry.args ?? {})).not.toContain('confirmToken');
    }
  });

  it('rejects an invalid VIN before any tool call', async () => {
    const server = createFakeServer();
    const report = await runPartslink24Scenario({
      call: server.call,
      waitForUser: async () => {},
      vin: 'NOT-A-VIN',
      script: TEST_SCRIPT,
    });
    expect(report.ok).toBe(false);
    expect(report.errorCode).toBe('invalid_vin');
    expect(server.calls).toHaveLength(0);
  });

  it('recovers when a deeper login wall hides the VIN field', async () => {
    // The start page has no wall, but the VIN locator does not match (the
    // live site shows the wall deeper than the homepage): the fill fails,
    // the probe finds the login wall, the engine hands over and retries.
    const server = createFakeServer({
      snapshot: (index) => ok({ snapshot: index === 1 ? CATALOG_SNAPSHOT : LOGIN_SNAPSHOT }),
      fill: (index) => (index === 1 ? err('timeout') : ok({ filled: true })),
    });
    const report = await runScenario(server);

    expect(report.ok).toBe(true);
    expect(report.handoffs).toEqual([{ kind: 'login', pageId: 'page-1', rounds: 1 }]);
    const pause = server.calls.find((entry) => entry.tool === 'human_required');
    expect(pause?.args?.['pageId']).toBe('page-1');
    // The fill was retried after the handoff and the flow completed.
    expect(server.calls.filter((entry) => entry.tool === 'page_fill')).toHaveLength(2);
  });

  it('detects a late challenge via the probe and hands over', async () => {
    // The click succeeds (server-side guard saw the old page), the wait times
    // out, the status is not paused — but the snapshot probe finds challenge
    // wording, so the engine pauses and hands over before retrying.
    let gateState = 'ready';
    const server = createFakeServer({
      wait: (index) => (index === 1 ? err('timeout') : ok({ waited: true })),
      snapshot: (index) => ok({ snapshot: index === 1 ? CATALOG_SNAPSHOT : CHALLENGE_SNAPSHOT }),
      status: () => ok({ humanControl: { state: gateState } }),
      resume: () => {
        gateState = 'ready';
        return ok({ resumed: true });
      },
    });
    const report = await runScenario(server, (handoff) => {
      if (handoff.kind === 'challenge') gateState = 'waiting_for_user';
    });

    expect(report.ok).toBe(true);
    expect(report.handoffs.some((handoff) => handoff.kind === 'challenge')).toBe(true);
    const pause = server.calls.find((entry) => entry.tool === 'human_required');
    expect(pause).toBeDefined();
  });

  it('masks the VIN everywhere in the report and its rendering', async () => {
    const server = createFakeServer();
    const report = await runScenario(server);

    expect(JSON.stringify(report)).not.toContain(VIN);
    expect(report.vinMasked).toBe(VIN_MASKED);
    const rendered = formatScenarioReport(report);
    expect(rendered).toContain(VIN_MASKED);
    expect(rendered).not.toContain(VIN);
    expect(rendered).toContain('PN-1');
  });

  it('captures transport errors from call() in the report', async () => {
    const report = await runPartslink24Scenario({
      call: async () => {
        throw new Error('connection refused');
      },
      waitForUser: async () => {},
      vin: VIN,
      script: TEST_SCRIPT,
    });
    expect(report.ok).toBe(false);
    expect(report.errorCode).toBe('internal_error');
    expect(report.errorMessage).toContain('connection refused');
  });
});

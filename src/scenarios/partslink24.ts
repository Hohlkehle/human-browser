/**
 * Stage 9: end-to-end Partslink24 scenario engine.
 *
 * Drives the Browser MCP tools through the real-world flow WITHOUT ever
 * receiving credentials:
 *
 *   1. open the site;
 *   2. on a login wall: pause via `human_required`, the user signs in manually
 *      in the visible Chrome (automation never fills or reads credentials);
 *   3. `human_resume`, then search the vehicle by VIN;
 *   4. on a CAPTCHA: the server pauses (`captcha_detected`), the user solves
 *      it manually, `human_resume` verifies and releases;
 *   5. extract ONLY the requested part numbers and their applicability.
 *
 * The engine is transport-agnostic: it receives a `call` function (any MCP
 * client — the CI integration test uses a real SDK client over Streamable
 * HTTP, the manual CLI uses the same) and a `waitForUser` callback that
 * resolves when the human finished the handed-over action.
 *
 * Privacy: the VIN is passed to `page_fill` (the adapter never echoes or logs
 * fill values) and appears nowhere else: every logged message and the final
 * report carry only the masked form (see `src/policy/vin.ts`). Purchases and
 * orders are never confirmed: a `confirmation_required` answer aborts the
 * scenario instead of consuming a token.
 */
import type { Logger } from 'pino';
import { describeChallenge, detectChallenge } from '../human/challenge.js';
import type { LocatorInput } from '../mcp/schemas.js';
import { isVin, maskVin, redactVinsInText } from '../policy/vin.js';

/** Minimal view of an MCP tool result the engine needs. */
export interface ScenarioToolResult {
  readonly isError?: boolean | undefined;
  readonly structuredContent?: Record<string, unknown> | undefined;
}

export type ScenarioToolCall = (
  tool: string,
  args?: Record<string, unknown>,
) => Promise<ScenarioToolResult>;

export type HandoffKind = 'login' | 'challenge';

/** What the human must do in the visible Chrome before automation resumes. */
export interface ScenarioHandoff {
  readonly kind: HandoffKind;
  readonly pageId: string;
  /** Safe explanation: hostname/provider only, never page content. */
  readonly reason: string;
  /** 1-based wait round for THIS handoff (grows while a challenge persists). */
  readonly attempt: number;
}

export type ScenarioWaitForUser = (handoff: ScenarioHandoff) => Promise<void>;

/** Site-specific locators; the engine flow itself is site-independent. */
export interface Partslink24Script {
  readonly startUrl: string;
  readonly search: {
    readonly vinLocator: LocatorInput;
    readonly submitLocator: LocatorInput;
  };
  readonly results: {
    /** Visible once the result list rendered (also gates the wait loop). */
    readonly waitLocator: LocatorInput;
    readonly partNumberLocator: LocatorInput;
    readonly applicabilityLocator: LocatorInput;
  };
}

/**
 * Best-effort locators for the real site. The Partslink24 markup can change;
 * when a locator stops matching, re-derive it with `page_snapshot` and pass a
 * custom script — see docs/partslink24-e2e.md.
 */
export const PARTSLINK24_SCRIPT: Partslink24Script = {
  startUrl: 'https://www.partslink24.com/',
  search: {
    vinLocator: { kind: 'label', label: 'VIN' },
    submitLocator: { kind: 'role', role: 'button', name: 'Search' },
  },
  results: {
    waitLocator: { kind: 'css', selector: 'table, [class*="result"], [class*="part"]' },
    partNumberLocator: { kind: 'css', selector: '[class*="part-number"], [class*="partNumber"]' },
    applicabilityLocator: { kind: 'css', selector: '[class*="applicab"]' },
  },
};

export interface ScenarioOptions {
  readonly call: ScenarioToolCall;
  readonly waitForUser: ScenarioWaitForUser;
  /** The VIN to search; masked in every log line and in the report. */
  readonly vin: string;
  readonly script?: Partslink24Script;
  readonly logger?: Logger;
  /** Max login-wall check rounds (each round is one human handover). */
  readonly maxLoginRounds?: number;
  /** Max wait rounds per handoff while a challenge persists. */
  readonly maxHandoffRounds?: number;
  /** Max polling rounds for the result list to appear. */
  readonly maxResultsRounds?: number;
  /** Per-round budget for the result-list wait. */
  readonly resultsWaitMs?: number;
}

export interface ScenarioStep {
  readonly tool: string;
  /** `ok` or the structured tool error code. */
  readonly outcome: string;
}

export interface HandoffRecord {
  readonly kind: HandoffKind;
  readonly pageId: string;
  /** How many wait rounds this handoff needed. */
  readonly rounds: number;
}

export interface ScenarioReport {
  readonly ok: boolean;
  readonly hostname?: string;
  readonly pageId?: string;
  /** Masked VIN — the full VIN is never part of any report. */
  readonly vinMasked: string;
  readonly handoffs: readonly HandoffRecord[];
  readonly partNumbers: readonly string[];
  readonly applicability: readonly string[];
  readonly truncated: boolean;
  readonly steps: readonly ScenarioStep[];
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export const DEFAULT_MAX_LOGIN_ROUNDS = 3;
export const DEFAULT_MAX_HANDOFF_ROUNDS = 3;
export const DEFAULT_MAX_RESULTS_ROUNDS = 4;
export const DEFAULT_RESULTS_WAIT_MS = 5_000;

/** Human-gate states in which every page_* tool is refused. */
const PAUSED_STATES = new Set<string>(['human_required', 'waiting_for_user', 'resuming', 'failed']);

/** A field name marking a probable password input in an ARIA snapshot line. */
const PASSWORD_FIELD_PATTERN = /(passw|passcode|парол)/i;

/** Login-wall wording (EN/RU/DE); ASCII \b does not work for Cyrillic. */
const LOGIN_PHRASES: readonly RegExp[] = [
  /(?<![a-z])sign[\s-]?in(?![a-z])/i,
  /(?<![a-z])log[\s-]?in(?![a-z])/i,
  /(?<![a-z])login(?![a-z])/i,
  /(?<![а-яё])войти(?![а-яё])/i,
  /(?<![а-яё])вход(?![а-яё])/i,
  /(?<![a-z])anmelden(?![a-z])/i,
];

/** Value-bearing roles in Playwright ARIA snapshots. */
const SNAPSHOT_FIELD_LINE =
  /^\s*-\s(?:textbox|searchbox|combobox|spinbutton)\s+"((?:[^"\\]|\\.)*)"/;

export type LoginWallDetection =
  | { readonly detected: true; readonly marker: 'password_field' | 'login_phrase' }
  | { readonly detected: false };

/**
 * Heuristic login-wall check on a redacted ARIA snapshot: a password-named
 * input field is the strong signal; login wording alone also counts (a false
 * pause is safe — the user just resumes — a missed wall is not).
 */
export function detectLoginWall(snapshot: string): LoginWallDetection {
  for (const line of snapshot.split('\n')) {
    const match = SNAPSHOT_FIELD_LINE.exec(line);
    if (match && PASSWORD_FIELD_PATTERN.test(match[1] as string)) {
      return { detected: true, marker: 'password_field' };
    }
  }
  for (const phrase of LOGIN_PHRASES) {
    if (phrase.test(snapshot)) return { detected: true, marker: 'login_phrase' };
  }
  return { detected: false };
}

class ScenarioAbort extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ScenarioAbort';
  }
}

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function structuredError(
  result: ScenarioToolResult,
): { code: string; message: string; pageId?: string } | undefined {
  const error = result.structuredContent?.['error'];
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record['code'] !== 'string') return undefined;
  return {
    code: record['code'],
    message: typeof record['message'] === 'string' ? record['message'] : '',
    ...(typeof record['pageId'] === 'string' ? { pageId: record['pageId'] } : {}),
  };
}

/**
 * Runs the full scenario. NEVER throws: every failure (including transport
 * errors from `call`/`waitForUser`) is captured in the returned report.
 */
export async function runPartslink24Scenario(options: ScenarioOptions): Promise<ScenarioReport> {
  const script = options.script ?? PARTSLINK24_SCRIPT;
  const vinMasked = maskVin(options.vin);
  const hostname = safeHostname(script.startUrl);
  const maxLoginRounds = options.maxLoginRounds ?? DEFAULT_MAX_LOGIN_ROUNDS;
  const maxHandoffRounds = options.maxHandoffRounds ?? DEFAULT_MAX_HANDOFF_ROUNDS;
  const maxResultsRounds = options.maxResultsRounds ?? DEFAULT_MAX_RESULTS_ROUNDS;
  const resultsWaitMs = options.resultsWaitMs ?? DEFAULT_RESULTS_WAIT_MS;
  const logger = options.logger?.child({ component: 'partslink24-scenario' });
  const steps: ScenarioStep[] = [];
  const handoffs: HandoffRecord[] = [];
  let pageId: string | undefined;

  const log = (level: 'info' | 'warn', message: string): void => {
    logger?.[level](redactVinsInText(message));
  };

  async function callTool(
    tool: string,
    args?: Record<string, unknown>,
  ): Promise<ScenarioToolResult> {
    const result = await options.call(tool, args);
    const failure = result.isError ? structuredError(result) : undefined;
    steps.push({ tool, outcome: failure ? failure.code : 'ok' });
    return result;
  }

  function abort(code: string, message: string): never {
    throw new ScenarioAbort(code, redactVinsInText(message));
  }

  function failReport(code: string, message: string): ScenarioReport {
    const safeMessage = redactVinsInText(message).slice(0, 500);
    log('warn', `scenario failed: ${code}: ${safeMessage}`);
    return {
      ok: false,
      ...(hostname !== undefined ? { hostname } : {}),
      ...(pageId !== undefined ? { pageId } : {}),
      vinMasked,
      handoffs,
      partNumbers: [],
      applicability: [],
      truncated: false,
      steps,
      errorCode: code,
      errorMessage: safeMessage,
    };
  }

  /**
   * Waits for the human and resumes, retrying while the server reports the
   * challenge still present. One HandoffRecord per handoff site.
   */
  async function resolveHandoff(
    kind: HandoffKind,
    handoffPageId: string,
    reason: string,
  ): Promise<void> {
    const index = handoffs.length;
    handoffs.push({ kind, pageId: handoffPageId, rounds: 0 });
    for (let attempt = 1; attempt <= maxHandoffRounds; attempt += 1) {
      handoffs[index] = { kind, pageId: handoffPageId, rounds: attempt };
      log('info', `handing over to the user (${kind}, round ${attempt}) on ${handoffPageId}`);
      await options.waitForUser({ kind, pageId: handoffPageId, reason, attempt });
      const resumed = await callTool('human_resume');
      if (!resumed.isError) {
        log('info', `resumed after ${kind} handoff (${attempt} round(s))`);
        return;
      }
      const failure = structuredError(resumed);
      if (failure?.code === 'challenge_still_present') continue;
      abort(failure?.code ?? 'resume_failed', failure?.message ?? 'human_resume failed');
    }
    abort(
      'challenge_not_resolved',
      `The user did not finish the ${kind} within ${maxHandoffRounds} attempts.`,
    );
  }

  /**
   * Server-side detection can lag or miss (a login wall is not a CAPTCHA):
   * probe the tab on demand — snapshot + login-wall heuristic + the Stage 6
   * challenge classifier. Snapshot text stays inside the scenario process.
   */
  async function probePageState(
    probePageId: string,
  ): Promise<{ kind: HandoffKind; reason: string } | undefined> {
    try {
      let url = '';
      const list = await callTool('page_list');
      if (!list.isError) {
        const pages = list.structuredContent?.['pages'];
        if (Array.isArray(pages)) {
          const current = pages.find(
            (page): page is Record<string, unknown> =>
              typeof page === 'object' && page !== null && page['pageId'] === probePageId,
          );
          if (current && typeof current['url'] === 'string') url = current['url'];
        }
      }
      const snapshot = await callTool('page_snapshot', { pageId: probePageId });
      if (snapshot.isError) return undefined;
      const text = snapshot.structuredContent?.['snapshot'];
      if (typeof text !== 'string') return undefined;

      if (detectLoginWall(text).detected) {
        return {
          kind: 'login',
          reason: `Login required on ${safeHostname(url) ?? hostname ?? 'the site'}. The user must sign in manually in the visible Chrome window; automation never fills or reads credentials.`,
        };
      }
      const detection = detectChallenge({ url, visibleText: text });
      if (!detection.detected) return undefined;
      return {
        kind: 'challenge',
        reason: `${describeChallenge(detection, safeHostname(url) ?? hostname)} (detected by the scenario probe)`,
      };
    } catch {
      return undefined;
    }
  }

  try {
    if (!isVin(options.vin)) {
      return failReport(
        'invalid_vin',
        'The search value is not a formally valid VIN (17 characters, no I/O/Q).',
      );
    }
    log('info', `scenario started for VIN ${vinMasked} on ${hostname ?? script.startUrl}`);

    // 1. Connect.
    const connected = await callTool('browser_connect');
    if (connected.isError) {
      const failure = structuredError(connected);
      return failReport(
        failure?.code ?? 'connect_failed',
        failure?.message ?? 'browser_connect failed',
      );
    }

    // 2. Open the site; a challenge on open pauses immediately (Stage 6).
    const opened = await callTool('page_open', { url: script.startUrl });
    if (opened.isError) {
      const failure = structuredError(opened);
      if (failure?.code === 'captcha_detected' && failure.pageId !== undefined) {
        pageId = failure.pageId;
        await resolveHandoff('challenge', pageId, failure.message);
      } else {
        return failReport(failure?.code ?? 'open_failed', failure?.message ?? 'page_open failed');
      }
    } else {
      const openedPageId = opened.structuredContent?.['pageId'];
      if (typeof openedPageId !== 'string')
        return failReport('internal_error', 'page_open returned no pageId');
      pageId = openedPageId;
    }

    // 3. Login wall: hand over until the signed-in page is confirmed.
    let signedIn = false;
    for (let round = 1; round <= maxLoginRounds && !signedIn; round += 1) {
      const snapshot = await callTool('page_snapshot', { pageId });
      if (snapshot.isError) {
        const failure = structuredError(snapshot);
        if (failure && (failure.code === 'human_required' || failure.code === 'captcha_detected')) {
          await resolveHandoff('challenge', pageId, failure.message);
          continue;
        }
        return failReport(
          failure?.code ?? 'snapshot_failed',
          failure?.message ?? 'page_snapshot failed',
        );
      }
      const text = snapshot.structuredContent?.['snapshot'];
      const wall = detectLoginWall(typeof text === 'string' ? text : '');
      if (!wall.detected) {
        signedIn = true;
        break;
      }
      log('info', `login wall detected (${wall.marker}); handing over to the user`);
      const reason = `Login required on ${hostname ?? 'the site'}. The user must sign in manually in the visible Chrome window; automation never fills or reads credentials.`;
      const pause = await callTool('human_required', { reason, pageId });
      if (pause.isError) {
        const failure = structuredError(pause);
        return failReport(
          failure?.code ?? 'pause_failed',
          failure?.message ?? 'human_required failed',
        );
      }
      await resolveHandoff('login', pageId, reason);
    }
    if (!signedIn) {
      return failReport(
        'login_not_completed',
        `The login wall was still present after ${maxLoginRounds} handover round(s).`,
      );
    }

    // 4. Search the vehicle by VIN. The fill value is never echoed or logged.
    // On failure the tab may sit behind a DEEPER login wall than the start
    // page (the live site shows one after brand selection): probe, hand over
    // once, then retry.
    let filled = await callTool('page_fill', {
      pageId,
      locator: script.search.vinLocator,
      value: options.vin,
    });
    if (filled.isError) {
      const failure = structuredError(filled);
      if (failure && (failure.code === 'human_required' || failure.code === 'captcha_detected')) {
        await resolveHandoff('challenge', pageId, failure.message);
      } else {
        const state = await probePageState(pageId);
        if (state !== undefined) {
          log('warn', `fill blocked by a ${state.kind} wall; handing over to the user`);
          if (state.kind === 'login') {
            await callTool('human_required', { reason: state.reason, pageId });
          }
          await resolveHandoff(state.kind, pageId, state.reason);
        }
      }
      filled = await callTool('page_fill', {
        pageId,
        locator: script.search.vinLocator,
        value: options.vin,
      });
    }
    if (filled.isError) {
      const failure = structuredError(filled);
      return failReport(failure?.code ?? 'fill_failed', failure?.message ?? 'page_fill failed');
    }

    const clicked = await callTool('page_click', {
      pageId,
      locator: script.search.submitLocator,
    });
    if (clicked.isError) {
      const failure = structuredError(clicked);
      if (failure?.code === 'captcha_detected') {
        await resolveHandoff('challenge', pageId, failure.message);
      } else if (failure?.code === 'confirmation_required') {
        // Purchases/orders are NEVER confirmed by the scenario.
        return failReport(
          'sensitive_action_forbidden',
          'The search submit was classified as a sensitive action; the scenario never confirms purchases or orders.',
        );
      } else {
        return failReport(failure?.code ?? 'click_failed', failure?.message ?? 'page_click failed');
      }
    }

    // 5. Wait for the result list; handle late challenges and slow loads.
    let resultsReady = false;
    for (let round = 1; round <= maxResultsRounds && !resultsReady; round += 1) {
      const status = await callTool('browser_status');
      if (!status.isError) {
        const control = status.structuredContent?.['humanControl'] as
          { state?: unknown } | undefined;
        if (typeof control?.state === 'string' && PAUSED_STATES.has(control.state)) {
          await resolveHandoff(
            'challenge',
            pageId,
            'A challenge was detected while waiting for the results.',
          );
          continue;
        }
      }
      const waited = await callTool('page_wait', {
        pageId,
        locator: script.results.waitLocator,
        state: 'visible',
        timeoutMs: resultsWaitMs,
      });
      if (!waited.isError) {
        resultsReady = true;
        break;
      }
      const failure = structuredError(waited);
      if (failure && (failure.code === 'human_required' || failure.code === 'captcha_detected')) {
        await resolveHandoff('challenge', pageId, failure.message);
        continue;
      }
      const state = await probePageState(pageId);
      if (state !== undefined) {
        log('warn', `late ${state.kind} detected while waiting for results`);
        await callTool('human_required', { reason: state.reason, pageId });
        await resolveHandoff(state.kind, pageId, state.reason);
        continue;
      }
      // No wall and no challenge: the page is simply slow; poll again.
    }
    if (!resultsReady) {
      return failReport(
        'results_timeout',
        'The result list did not appear within the wait budget.',
      );
    }

    // 6. Extract ONLY the requested data: part numbers and applicability.
    async function extractItems(
      locator: LocatorInput,
      label: string,
    ): Promise<{ items: string[]; truncated: boolean }> {
      const result = await callTool('page_extract', { pageId, locator });
      if (result.isError) {
        const failure = structuredError(result);
        if (failure && (failure.code === 'human_required' || failure.code === 'captcha_detected')) {
          await resolveHandoff('challenge', pageId as string, failure.message);
          const retry = await callTool('page_extract', { pageId, locator });
          if (retry.isError) {
            const retryFailure = structuredError(retry);
            abort(
              retryFailure?.code ?? 'extract_failed',
              retryFailure?.message ?? `page_extract (${label}) failed`,
            );
          }
          return readItems(retry, label);
        }
        abort(
          failure?.code ?? 'extract_failed',
          failure?.message ?? `page_extract (${label}) failed`,
        );
      }
      return readItems(result, label);
    }

    function readItems(
      result: ScenarioToolResult,
      label: string,
    ): { items: string[]; truncated: boolean } {
      const raw = result.structuredContent?.['items'];
      if (!Array.isArray(raw)) abort('extract_failed', `page_extract (${label}) returned no items`);
      const items = raw.filter((item): item is string => typeof item === 'string');
      const truncated = result.structuredContent?.['truncated'] === true;
      return { items, truncated };
    }

    const partNumbers = await extractItems(script.results.partNumberLocator, 'part numbers');
    const applicability = await extractItems(script.results.applicabilityLocator, 'applicability');

    log(
      'info',
      `scenario finished: ${partNumbers.items.length} part number(s), ${applicability.items.length} applicability record(s)`,
    );
    return {
      ok: true,
      ...(hostname !== undefined ? { hostname } : {}),
      pageId,
      vinMasked,
      handoffs,
      partNumbers: partNumbers.items,
      applicability: applicability.items,
      truncated: partNumbers.truncated || applicability.truncated,
      steps,
    };
  } catch (error) {
    if (error instanceof ScenarioAbort) {
      return failReport(error.code, error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    return failReport('internal_error', message);
  }
}

/** Renders the report as a bounded, VIN-redacted markdown summary. */
export function formatScenarioReport(report: ScenarioReport): string {
  const lines: string[] = [];
  lines.push(`# Partslink24 E2E ${report.ok ? 'OK' : 'FAILED'}`);
  lines.push('');
  lines.push(`- VIN: ${report.vinMasked}`);
  if (report.hostname !== undefined) lines.push(`- Host: ${report.hostname}`);
  if (report.pageId !== undefined) lines.push(`- Tab: ${report.pageId}`);
  for (const handoff of report.handoffs) {
    lines.push(`- Handoff: ${handoff.kind} on ${handoff.pageId} (${handoff.rounds} round(s))`);
  }
  if (report.ok) {
    lines.push(`- Part numbers (${report.partNumbers.length}):`);
    for (const part of report.partNumbers) lines.push(`  - ${redactVinsInText(part)}`);
    lines.push(`- Applicability (${report.applicability.length}):`);
    for (const appl of report.applicability) lines.push(`  - ${redactVinsInText(appl)}`);
    if (report.truncated) lines.push('- Note: extraction was truncated by the adapter limits.');
  } else {
    lines.push(`- Error: ${report.errorCode ?? 'unknown'}: ${report.errorMessage ?? ''}`);
  }
  lines.push('');
  lines.push('Steps:');
  for (const step of report.steps) lines.push(`- ${step.tool} -> ${step.outcome}`);
  return redactVinsInText(lines.join('\n'));
}

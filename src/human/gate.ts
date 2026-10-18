/**
 * Human-control state machine (Stage 6).
 *
 * Automation of the visible Chrome is a six-state machine:
 *
 *   ready ──op started──▶ running ──op finished──▶ ready
 *     │                      │
 *     │      challenge detected / human_required tool
 *     ▼                      ▼
 *   human_required ──acknowledged──▶ waiting_for_user ──human_resume──▶ resuming
 *                                        ▲      │                          │  │
 *                                        │      └────── timeout ──▶ failed │  │
 *                                        └── challenge still present ──────┘  │
 *                                                ready ◀── challenge gone ────┘
 *
 * - `ready`/`running`: automation is allowed; `running` merely tracks that at
 *   least one tool operation is in flight.
 * - `human_required`: a probable CAPTCHA/challenge was detected server-side;
 *   automatic actions stop, the tab stays visible for the user.
 * - `waiting_for_user`: the user is working in the visible Chrome (CAPTCHA,
 *   login, sensitive confirmation). EVERY `page_*` tool is refused — including
 *   reads — so the model can never observe what the user is typing.
 * - `resuming`: `human_resume` was called; the challenge is being re-checked
 *   before automation is released.
 * - `failed`: the wait timed out (`timeoutMs`); tools stay blocked until a new
 *   `human_required` (fresh wait) or a successful `human_resume`.
 *
 * The wait timer is `unref()`ed and cleared by `dispose()`, so it can never
 * delay process shutdown.
 */

export type HumanGateState =
  'ready' | 'running' | 'human_required' | 'waiting_for_user' | 'resuming' | 'failed';

/** Why the machine is waiting: auto-detected challenge or an explicit handover. */
export type HumanPauseKind = 'challenge' | 'manual';

export interface HumanGatePauseParams {
  /** Human-readable reason; surfaced to the user and the model. */
  readonly reason: string;
  /** The tab the human should work in, when known. */
  readonly pageId?: string;
  readonly kind?: HumanPauseKind;
  /** Hostname of the challenged tab (safe metadata, never a full URL). */
  readonly hostname?: string;
  /** Challenge provider label when the pause was triggered by detection. */
  readonly provider?: string;
}

export interface HumanGateSnapshot {
  readonly state: HumanGateState;
  readonly reason?: string;
  readonly pageId?: string;
  readonly kind?: HumanPauseKind;
  readonly hostname?: string;
  readonly provider?: string;
  /** ISO timestamp when the current wait round started. */
  readonly pausedAt?: string;
  /** ISO timestamp when the wait fails itself if not resumed. */
  readonly timeoutAt?: string;
}

export interface HumanGateOptions {
  /** How long to wait for the user before the machine fails itself. */
  readonly timeoutMs?: number;
  readonly clock?: () => Date;
  /** Invoked when the wait times out (state becomes `failed`). */
  readonly onTimeout?: (snapshot: HumanGateSnapshot) => void;
}

export interface HumanGate {
  state(): HumanGateState;
  snapshot(): HumanGateSnapshot;
  /** True in every state where `page_*` tools must be refused. */
  isPaused(): boolean;
  /** Tracks in-flight operations: ready ↔ running. */
  operationStarted(): void;
  operationFinished(): void;
  /** Server-side challenge detection: ready/running → human_required. */
  challengeDetected(params: HumanGatePauseParams): HumanGateSnapshot;
  /** Explicit handover (`human_required` tool): → waiting_for_user. */
  pause(params: HumanGatePauseParams): HumanGateSnapshot;
  /** `human_resume` called: paused/failed → resuming. */
  beginResume(): HumanGateSnapshot;
  /** Challenge verified gone: resuming → ready. */
  completeResume(): HumanGateSnapshot;
  /** Challenge still present: resuming → waiting_for_user (wait continues). */
  abortResume(): HumanGateSnapshot;
  /** Clears the wait timer; the machine must not be used afterwards. */
  dispose(): void;
}

export const MAX_PAUSE_REASON_CHARS = 500;
export const DEFAULT_HUMAN_TIMEOUT_MS = 300_000;

const BLOCKED_STATES: ReadonlySet<HumanGateState> = new Set<HumanGateState>([
  'human_required',
  'waiting_for_user',
  'resuming',
  'failed',
]);

export function createHumanGate(options: HumanGateOptions = {}): HumanGate {
  const clock = options.clock ?? ((): Date => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_HUMAN_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('human gate timeoutMs must be a positive number');
  }

  let state: HumanGateState = 'ready';
  let runningOperations = 0;
  let reason: string | undefined;
  let pageId: string | undefined;
  let kind: HumanPauseKind | undefined;
  let hostname: string | undefined;
  let provider: string | undefined;
  let pausedAt: string | undefined;
  let timeoutAt: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let disposed = false;

  function clearTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function snapshot(): HumanGateSnapshot {
    return {
      state,
      ...(reason !== undefined ? { reason } : {}),
      ...(pageId !== undefined ? { pageId } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(hostname !== undefined ? { hostname } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(pausedAt !== undefined ? { pausedAt } : {}),
      ...(timeoutAt !== undefined ? { timeoutAt } : {}),
    };
  }

  /** Arms the wait timeout for the current wait round. */
  function armTimer(): void {
    clearTimer();
    const deadline = new Date(clock().getTime() + timeoutMs);
    timeoutAt = deadline.toISOString();
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed) return;
      if (state === 'human_required' || state === 'waiting_for_user') {
        state = 'failed';
        timeoutAt = undefined;
        options.onTimeout?.(snapshot());
      }
    }, timeoutMs);
    // The wait must never keep the process alive or delay shutdown.
    timer.unref();
  }

  function storePauseInfo(params: HumanGatePauseParams): void {
    reason = params.reason.slice(0, MAX_PAUSE_REASON_CHARS);
    pageId = params.pageId;
    kind = params.kind ?? 'manual';
    hostname = params.hostname;
    provider = params.provider;
    pausedAt = clock().toISOString();
  }

  function clearPauseInfo(): void {
    reason = undefined;
    pageId = undefined;
    kind = undefined;
    hostname = undefined;
    provider = undefined;
    pausedAt = undefined;
    timeoutAt = undefined;
  }

  return {
    state: () => state,
    snapshot,
    isPaused: () => BLOCKED_STATES.has(state),

    operationStarted() {
      if (state !== 'ready' && state !== 'running') return;
      runningOperations += 1;
      state = 'running';
    },

    operationFinished() {
      if (runningOperations > 0) runningOperations -= 1;
      if (state === 'running' && runningOperations === 0) state = 'ready';
    },

    challengeDetected(params) {
      // The first pause wins: a later detection cannot clobber an ongoing
      // human handover.
      if (BLOCKED_STATES.has(state)) return snapshot();
      runningOperations = 0;
      state = 'human_required';
      storePauseInfo({ ...params, kind: params.kind ?? 'challenge' });
      armTimer();
      return snapshot();
    },

    pause(params) {
      if (state === 'waiting_for_user' || state === 'resuming') return snapshot();
      if (state === 'human_required') {
        // Acknowledged: the user/model was informed, the wait continues with
        // the ORIGINAL reason (first pause wins).
        state = 'waiting_for_user';
        return snapshot();
      }
      if (state === 'failed') {
        // A fresh wait round on top of the timed-out one.
        state = 'waiting_for_user';
        storePauseInfo(params);
        armTimer();
        return snapshot();
      }
      runningOperations = 0;
      state = 'waiting_for_user';
      storePauseInfo(params);
      armTimer();
      return snapshot();
    },

    beginResume() {
      if (state === 'human_required' || state === 'waiting_for_user' || state === 'failed') {
        clearTimer();
        timeoutAt = undefined;
        state = 'resuming';
      }
      return snapshot();
    },

    completeResume() {
      if (state === 'resuming') {
        state = 'ready';
        clearPauseInfo();
      }
      return snapshot();
    },

    abortResume() {
      if (state === 'resuming') {
        state = 'waiting_for_user';
        armTimer();
      }
      return snapshot();
    },

    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}

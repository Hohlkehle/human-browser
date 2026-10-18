export interface RateLimitOptions {
  /** Fixed window length in milliseconds. */
  readonly windowMs: number;
  /** Maximum hits allowed per key per window. */
  readonly max: number;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Remaining hits in the current window (0 when denied). */
  readonly remaining: number;
  /** Milliseconds until the window resets; 0 when allowed. */
  readonly retryAfterMs: number;
}

/** Entries are pruned lazily once the table grows past this size. */
const PRUNE_THRESHOLD = 4096;

/**
 * Dependency-free fixed-window rate limiter keyed by client identity
 * (the gateway keys by normalized remote IP). No timers are created: stale
 * windows are reset on access and pruned lazily, so the limiter never keeps
 * the event loop alive or delays shutdown.
 */
export class FixedWindowRateLimiter {
  private readonly windowMs: number;
  private readonly max: number;
  private readonly now: () => number;
  private readonly windows = new Map<string, { windowStart: number; count: number }>();

  constructor(options: RateLimitOptions) {
    if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
      throw new Error('rateLimit windowMs must be a positive number');
    }
    if (!Number.isFinite(options.max) || options.max <= 0) {
      throw new Error('rateLimit max must be a positive number');
    }
    this.windowMs = options.windowMs;
    this.max = options.max;
    this.now = options.now ?? Date.now;
  }

  hit(key: string): RateLimitDecision {
    const timestamp = this.now();
    let entry = this.windows.get(key);

    if (!entry || timestamp - entry.windowStart >= this.windowMs) {
      entry = { windowStart: timestamp, count: 0 };
      this.windows.set(key, entry);
    }

    entry.count += 1;
    if (this.windows.size > PRUNE_THRESHOLD) this.prune(timestamp);

    if (entry.count <= this.max) {
      return { allowed: true, remaining: this.max - entry.count, retryAfterMs: 0 };
    }
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.max(1, entry.windowStart + this.windowMs - timestamp),
    };
  }

  /** Number of tracked keys (exposed for tests and diagnostics). */
  get size(): number {
    return this.windows.size;
  }

  private prune(timestamp: number): void {
    for (const [key, entry] of this.windows) {
      if (timestamp - entry.windowStart >= this.windowMs) this.windows.delete(key);
    }
  }
}

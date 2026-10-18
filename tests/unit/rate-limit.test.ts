import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from '../../src/cdp/rate-limit.js';

describe('FixedWindowRateLimiter', () => {
  it('allows hits up to the limit and then denies with retry-after', () => {
    const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, max: 3 });

    const first = limiter.hit('10.0.0.1');
    const second = limiter.hit('10.0.0.1');
    const third = limiter.hit('10.0.0.1');
    const fourth = limiter.hit('10.0.0.1');

    expect(first).toEqual({ allowed: true, remaining: 2, retryAfterMs: 0 });
    expect(second.allowed).toBe(true);
    expect(third).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
    expect(fourth.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it('tracks keys independently', () => {
    const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, max: 1 });

    expect(limiter.hit('10.0.0.1').allowed).toBe(true);
    expect(limiter.hit('10.0.0.2').allowed).toBe(true);
    expect(limiter.hit('10.0.0.1').allowed).toBe(false);
    expect(limiter.hit('10.0.0.2').allowed).toBe(false);
  });

  it('resets the window after it elapses', () => {
    let now = 1_000_000;
    const limiter = new FixedWindowRateLimiter({ windowMs: 1_000, max: 1, now: () => now });

    expect(limiter.hit('k').allowed).toBe(true);
    expect(limiter.hit('k').allowed).toBe(false);

    now += 1_000;
    expect(limiter.hit('k').allowed).toBe(true);
  });

  it('prunes stale entries lazily', () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter({
      windowMs: 10,
      max: 1,
      now: () => now,
    });

    for (let i = 0; i < 5000; i += 1) limiter.hit(`key-${i}`);
    expect(limiter.size).toBeGreaterThan(4096);

    now += 100; // all windows expired
    limiter.hit('trigger');
    expect(limiter.size).toBeLessThanOrEqual(2);
  });

  it('rejects invalid options', () => {
    expect(() => new FixedWindowRateLimiter({ windowMs: 0, max: 1 })).toThrow(/windowMs/);
    expect(() => new FixedWindowRateLimiter({ windowMs: 100, max: 0 })).toThrow(/max/);
  });
});

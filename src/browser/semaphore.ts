/**
 * Bounded concurrency gate for browser operations.
 *
 * At most `maxConcurrent` operations run at once; further callers queue FIFO up
 * to `maxQueued`. When the queue is full the operation is rejected immediately
 * (backpressure to the caller) instead of piling up against the user's browser.
 * No timers are created, so the semaphore can never delay process shutdown.
 */

export class SemaphoreFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SemaphoreFullError';
  }
}

/** Releases the acquired slot; safe to call exactly once. */
export type SemaphoreRelease = () => void;

interface Waiter {
  resolve(release: SemaphoreRelease): void;
  reject(error: Error): void;
}

export class OperationSemaphore {
  readonly maxConcurrent: number;

  readonly maxQueued: number;

  #running = 0;

  #waiters: Waiter[] = [];

  constructor(maxConcurrent: number, maxQueued: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error('maxConcurrent must be a positive integer');
    }
    if (!Number.isInteger(maxQueued) || maxQueued < 0) {
      throw new Error('maxQueued must be a non-negative integer');
    }
    this.maxConcurrent = maxConcurrent;
    this.maxQueued = maxQueued;
  }

  get runningCount(): number {
    return this.#running;
  }

  get waitingCount(): number {
    return this.#waiters.length;
  }

  /**
   * Acquires a slot. Resolves immediately when a slot is free, otherwise waits
   * in FIFO order. Rejects with `SemaphoreFullError` when the queue is full and
   * with an `AbortError` when `signal` aborts while waiting.
   */
  acquire(signal?: AbortSignal): Promise<SemaphoreRelease> {
    if (signal?.aborted) {
      return Promise.reject(this.abortError());
    }
    if (this.#running < this.maxConcurrent) {
      this.#running += 1;
      return Promise.resolve(this.makeRelease());
    }
    if (this.#waiters.length >= this.maxQueued) {
      return Promise.reject(
        new SemaphoreFullError(
          `Operation rejected: ${this.maxConcurrent} operations running and ` +
            `${this.maxQueued} already queued`,
        ),
      );
    }
    return new Promise<SemaphoreRelease>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      this.#waiters.push(waiter);
      signal?.addEventListener(
        'abort',
        () => {
          const position = this.#waiters.indexOf(waiter);
          if (position === -1) return; // already handed a slot
          this.#waiters.splice(position, 1);
          reject(this.abortError());
        },
        { once: true },
      );
    });
  }

  private makeRelease(): SemaphoreRelease {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next) {
        // Hand the slot straight to the next waiter in FIFO order.
        next.resolve(this.makeRelease());
        return;
      }
      this.#running -= 1;
    };
  }

  private abortError(): Error {
    const error = new Error('Operation aborted while waiting for a free slot');
    error.name = 'AbortError';
    return error;
  }
}

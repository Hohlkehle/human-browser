import { describe, expect, it } from 'vitest';
import { OperationSemaphore, SemaphoreFullError } from '../../src/browser/semaphore.js';

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('OperationSemaphore', () => {
  it('rejects invalid construction arguments', () => {
    expect(() => new OperationSemaphore(0, 0)).toThrow();
    expect(() => new OperationSemaphore(1.5, 0)).toThrow();
    expect(() => new OperationSemaphore(1, -1)).toThrow();
  });

  it('grants up to maxConcurrent slots immediately', async () => {
    const semaphore = new OperationSemaphore(2, 4);
    const first = await semaphore.acquire();
    const second = await semaphore.acquire();
    expect(semaphore.runningCount).toBe(2);
    expect(semaphore.waitingCount).toBe(0);
    first();
    second();
    expect(semaphore.runningCount).toBe(0);
  });

  it('queues callers FIFO beyond the limit and hands slots over in order', async () => {
    const semaphore = new OperationSemaphore(1, 4);
    const order: string[] = [];

    const first = await semaphore.acquire();
    const second = semaphore.acquire().then((release) => {
      order.push('second');
      return release;
    });
    const third = semaphore.acquire().then((release) => {
      order.push('third');
      return release;
    });
    expect(semaphore.waitingCount).toBe(2);

    first();
    const secondRelease = await second;
    secondRelease();
    const thirdRelease = await third;
    thirdRelease();

    expect(order).toEqual(['second', 'third']);
    expect(semaphore.runningCount).toBe(0);
    expect(semaphore.waitingCount).toBe(0);
  });

  it('rejects immediately when the queue is full', async () => {
    const semaphore = new OperationSemaphore(1, 1);
    const first = await semaphore.acquire();
    const queued = semaphore.acquire(); // occupies the only queue slot
    await expect(semaphore.acquire()).rejects.toBeInstanceOf(SemaphoreFullError);
    first();
    await queued;
  });

  it('rejects a zero-queue semaphore as soon as the slot is busy', async () => {
    const semaphore = new OperationSemaphore(1, 0);
    const first = await semaphore.acquire();
    await expect(semaphore.acquire()).rejects.toBeInstanceOf(SemaphoreFullError);
    first();
    const again = await semaphore.acquire();
    again();
  });

  it('rejects an already-aborted signal', async () => {
    const semaphore = new OperationSemaphore(1, 1);
    await expect(semaphore.acquire(AbortSignal.abort())).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('aborts a queued waiter without consuming a slot', async () => {
    const semaphore = new OperationSemaphore(1, 4);
    const first = await semaphore.acquire();
    const controller = new AbortController();
    const waiting = semaphore.acquire(controller.signal);
    expect(semaphore.waitingCount).toBe(1);

    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(semaphore.waitingCount).toBe(0);

    // The slot still belongs to the first holder.
    expect(semaphore.runningCount).toBe(1);
    first();
    expect(semaphore.runningCount).toBe(0);
  });

  it('release is idempotent', async () => {
    const semaphore = new OperationSemaphore(1, 0);
    const release = await semaphore.acquire();
    release();
    release();
    expect(semaphore.runningCount).toBe(0);
    const again = await semaphore.acquire();
    again();
  });

  it('keeps granting while releases race acquisitions', async () => {
    const semaphore = new OperationSemaphore(2, 8);
    const gate = defer();
    let completed = 0;
    const workers = Array.from({ length: 10 }, async () => {
      const release = await semaphore.acquire();
      await gate.promise;
      completed += 1;
      release();
    });
    gate.resolve();
    await Promise.all(workers);
    expect(completed).toBe(10);
    expect(semaphore.runningCount).toBe(0);
    expect(semaphore.waitingCount).toBe(0);
  });
});

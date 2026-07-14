import { describe, expect, it } from 'bun:test';
import { createSyncLoop } from './loop';
import type { SyncRunResult } from './types';

describe('sync loop', () => {
  it('reschedules with the idle delay after an idle result', async () => {
    const timers = new FakeTimers();
    const results: SyncRunResult[] = [{ processed: 0, status: 'idle' }];
    const scheduler = { runOnce: async () => results.shift() ?? { processed: 0, status: 'idle' } };
    const observed: SyncRunResult[] = [];

    const loop = createSyncLoop({
      activeDelayMs: 0,
      clearTimeoutFn: timers.clear,
      idleDelayMs: 2000,
      onResult: (result) => observed.push(result),
      scheduler,
      setTimeoutFn: timers.set,
    });

    loop.start();
    await flush();

    expect(observed).toEqual([{ processed: 0, status: 'idle' }]);
    expect(timers.scheduledDelays).toEqual([2000]);

    await loop.stop();
  });

  it('reschedules almost immediately (activeDelayMs) after a job was actually processed', async () => {
    const timers = new FakeTimers();
    const scheduler = {
      runOnce: async (): Promise<SyncRunResult> => ({
        jobId: 'job_1',
        processed: 1,
        status: 'synced',
      }),
    };
    const observed: SyncRunResult[] = [];

    const loop = createSyncLoop({
      activeDelayMs: 0,
      clearTimeoutFn: timers.clear,
      idleDelayMs: 2000,
      onResult: (result) => observed.push(result),
      scheduler,
      setTimeoutFn: timers.set,
    });

    loop.start();
    await flush();

    expect(observed).toEqual([{ jobId: 'job_1', processed: 1, status: 'synced' }]);
    expect(timers.scheduledDelays).toEqual([0]);

    await loop.stop();
  });

  it('defaults the active delay to 150ms as a hot-spin guard when not overridden', async () => {
    const timers = new FakeTimers();
    const scheduler = {
      runOnce: async (): Promise<SyncRunResult> => ({
        jobId: 'job_1',
        processed: 1,
        status: 'retry_wait',
      }),
    };

    const loop = createSyncLoop({
      clearTimeoutFn: timers.clear,
      idleDelayMs: 2000,
      scheduler,
      setTimeoutFn: timers.set,
    });

    loop.start();
    await flush();

    expect(timers.scheduledDelays).toEqual([150]);

    await loop.stop();
  });

  it('never overlaps two runOnce() calls: the next run is only scheduled after the previous settles', async () => {
    const timers = new FakeTimers();
    let concurrentCalls = 0;
    let maxConcurrentCalls = 0;
    let callCount = 0;

    const scheduler = {
      async runOnce(): Promise<SyncRunResult> {
        callCount += 1;
        concurrentCalls += 1;
        maxConcurrentCalls = Math.max(maxConcurrentCalls, concurrentCalls);
        await Promise.resolve();
        await Promise.resolve();
        concurrentCalls -= 1;
        return { processed: 0, status: 'idle' };
      },
    };

    const loop = createSyncLoop({
      clearTimeoutFn: timers.clear,
      idleDelayMs: 5,
      scheduler,
      setTimeoutFn: timers.set,
    });

    loop.start();
    await flush();
    timers.fireAll();
    await flush();
    timers.fireAll();
    await flush();

    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(maxConcurrentCalls).toBe(1);

    await loop.stop();
  });

  it('start() is idempotent while already running', async () => {
    const timers = new FakeTimers();
    let calls = 0;
    const scheduler = {
      runOnce: async (): Promise<SyncRunResult> => {
        calls += 1;
        return { processed: 0, status: 'idle' };
      },
    };

    const loop = createSyncLoop({
      clearTimeoutFn: timers.clear,
      scheduler,
      setTimeoutFn: timers.set,
    });

    loop.start();
    loop.start();
    await flush();

    expect(calls).toBe(1);

    await loop.stop();
  });

  it('stop() cancels the pending timer and waits for an in-flight run to settle', async () => {
    const timers = new FakeTimers();
    let resolveRun: (() => void) | undefined;
    const scheduler = {
      runOnce: () =>
        new Promise<SyncRunResult>((resolve) => {
          resolveRun = () => resolve({ processed: 0, status: 'idle' });
        }),
    };

    const loop = createSyncLoop({
      clearTimeoutFn: timers.clear,
      scheduler,
      setTimeoutFn: timers.set,
    });
    loop.start();
    await flush();

    const stopPromise = loop.stop();
    let stopped = false;
    void stopPromise.then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);

    resolveRun?.();
    await stopPromise;
    expect(stopped).toBe(true);
    // No further run should be scheduled after stop() was requested, even
    // though the in-flight run resolved with a result that would otherwise
    // trigger a reschedule.
    expect(timers.scheduledDelays).toEqual([]);
  });

  it('recovers from a runOnce() rejection by rescheduling at the idle delay instead of dying', async () => {
    const timers = new FakeTimers();
    let calls = 0;
    const errors: unknown[] = [];
    const scheduler = {
      runOnce: async (): Promise<SyncRunResult> => {
        calls += 1;
        if (calls === 1) {
          throw new Error('store unavailable');
        }
        return { processed: 0, status: 'idle' };
      },
    };

    const loop = createSyncLoop({
      idleDelayMs: 7,
      onError: (error) => errors.push(error),
      clearTimeoutFn: timers.clear,
      scheduler,
      setTimeoutFn: timers.set,
    });

    loop.start();
    await flush();

    expect(errors).toHaveLength(1);
    expect(timers.scheduledDelays).toEqual([7]);

    timers.fireAll();
    await flush();
    expect(calls).toBe(2);

    await loop.stop();
  });
});

class FakeTimers {
  scheduledDelays: number[] = [];
  private handles: Array<{ id: number; callback: () => void; cancelled: boolean }> = [];
  private nextId = 1;

  set = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++;
    this.scheduledDelays.push(delayMs);
    this.handles.push({ callback, cancelled: false, id });
    return id;
  };

  clear = (handle: unknown): void => {
    const entry = this.handles.find((item) => item.id === handle);
    if (entry) {
      entry.cancelled = true;
    }
  };

  fireAll(): void {
    const pending = this.handles.splice(0);
    for (const entry of pending) {
      if (!entry.cancelled) {
        entry.callback();
      }
    }
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

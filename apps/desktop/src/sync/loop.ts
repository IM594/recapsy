import type { SyncRunResult, SyncRunStatus } from './types';

/**
 * Narrow surface this loop depends on: just `runOnce()` from
 * `createSyncWorker(...)` (see `sync/worker.ts`). Duck-typed so tests
 * can supply a fake worker without composing the worker's dependencies.
 */
export type SyncLoopRunner = {
  runOnce(): Promise<SyncRunResult>;
};

const IDLE_STATUSES: ReadonlySet<SyncRunStatus> = new Set(['idle', 'skipped']);

export type SyncLoopOptions = {
  worker: SyncLoopRunner;
  /**
   * Delay before the next `runOnce()` when the last call found nothing to do
   * (`idle`/`skipped`, e.g. no workspace or an empty outbox). Default 2000ms
   * per the task's guidance to avoid hot-looping the server when there is no
   * work.
   */
  idleDelayMs?: number;
  /**
   * Delay before the next `runOnce()` when the last call actually processed
   * a job (`synced`/`retry_wait`/`blocked`/`failed`/`cancelled`). Default
   * 150ms: `claimNextRetryableOutboxJob` only returns jobs that are due, so
   * steady-state draining is naturally serialized by the synchronous OCR proxy
   * call. The small non-zero gap is a cheap guard against a hot spin when a run
   * of ready jobs all fail fast (immediate 429/5xx) — it caps the drain rate
   * so a fast-failing queue can't hammer the server, while the exponential
   * backoff and the server's per-user in-flight limit remain the primary
   * throttles (see `docs/design/OCR_OUTBOX_STATE_MACHINE.md` §4.3).
   */
  activeDelayMs?: number;
  /** Injection points so tests can drive this deterministically. */
  setTimeoutFn?: (callback: () => void, delayMs: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** Optional observability hook, e.g. for tests or diagnostics logging. */
  onResult?(result: SyncRunResult): void;
  onError?(error: unknown): void;
};

export type SyncLoop = {
  /** Idempotent: calling `start()` while already running is a no-op. */
  start(): void;
  /**
   * Stops scheduling further runs and waits for any in-flight `runOnce()` to
   * settle before resolving, mirroring the "wait for the current step before
   * deciding the next one" shape `helper/process-client.ts`
   * uses for its own shutdown (`waitForExit`) — applied here to avoid two
   * overlapping `runOnce()` calls racing the same outbox claim.
   */
  stop(): Promise<void>;
};

/**
 * Turns `createSyncWorker(...).runOnce()` (see `sync/worker.ts`), which
 * only processes a single outbox job per call, into a continuously
 * self-rescheduling loop. Deliberately not a bare `setInterval`: `runOnce()`
 * is an async network-bound call, and a fixed-interval timer would let two
 * calls overlap and race the same `claimNextRetryableOutboxJob` if a run
 * takes longer than the interval. Each call is instead scheduled only after
 * the previous one has fully settled.
 */
export function createSyncLoop(options: SyncLoopOptions): SyncLoop {
  const idleDelayMs = options.idleDelayMs ?? 2000;
  const activeDelayMs = options.activeDelayMs ?? 150;
  // Wrapped (rather than passing `setTimeout`/`clearTimeout` directly) so
  // this compiles the same way regardless of which ambient `Timeout`/`Timer`
  // lib types are in scope, and so the injected function signatures in
  // `SyncLoopOptions` stay simple (`unknown` handles) for tests.
  const scheduleTimeout =
    options.setTimeoutFn ??
    ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const cancelTimeout =
    options.clearTimeoutFn ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));

  let running = false;
  let timerHandle: unknown;
  let inFlight: Promise<void> | undefined;

  function scheduleNext(delayMs: number): void {
    if (!running) {
      return;
    }

    timerHandle = scheduleTimeout(() => {
      inFlight = tick();
    }, delayMs);
  }

  async function tick(): Promise<void> {
    if (!running) {
      return;
    }

    try {
      const result = await options.worker.runOnce();
      options.onResult?.(result);
      scheduleNext(IDLE_STATUSES.has(result.status) ? idleDelayMs : activeDelayMs);
    } catch (error) {
      // The job executor already classifies job-level failures into terminal
      // outbox states instead of throwing (see `sync/job.ts`), so
      // reaching here means something unexpected happened outside a single
      // job (e.g. the store itself is unavailable). The loop must not die
      // silently — fall back to the idle delay and keep trying.
      options.onError?.(error);
      scheduleNext(idleDelayMs);
    }
  }

  return {
    start() {
      if (running) {
        return;
      }

      running = true;
      inFlight = tick();
    },
    async stop() {
      running = false;

      if (timerHandle !== undefined) {
        cancelTimeout(timerHandle);
        timerHandle = undefined;
      }

      await inFlight;
    },
  };
}

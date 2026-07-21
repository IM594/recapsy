import type { CaptureCoverageSegmentInput } from '@recapsy/contracts';
import type { CaptureCoverageStore } from '../capture/index';
import type { ServerApiCoverageClient } from '../server/index';
import type { CaptureCoverageSegmentRecord } from '../storage/index';

// Coverage sync is deliberately separate from the OCR/capture sync worker
// system (`sync/runtime.ts`): coverage segments carry no asset bytes and no OCR
// work, run on a low-priority cadence, and must never contend with capture/OCR
// sync. A closed run-length segment is authoritative locally; this job ships
// the pending ones and refreshes the device's liveness row.

const DEFAULT_COVERAGE_SYNC_BATCH_SIZE = 200;
const DEFAULT_COVERAGE_SYNC_INTERVAL_MS = 45_000;

export type CoverageSyncStore = Pick<
  CaptureCoverageStore,
  'listPendingCoverageSegments' | 'markCoverageSegmentsSynced' | 'getDeviceCaptureLiveness'
>;

export type CoverageSyncPassDeps = {
  api: ServerApiCoverageClient;
  store: CoverageSyncStore;
  workspaceId: string;
  deviceId: string;
  batchSize?: number;
};

export type CoverageSyncPassResult = {
  syncedSegments: number;
  livenessUpserted: boolean;
};

/**
 * One coverage sync pass: ship every pending closed segment in batches, mark
 * each shipped batch synced, then upsert this device's liveness row. Segments
 * are marked synced only after the server accepts them, so a failure mid-run
 * leaves the rest pending for the next pass (the server upsert is idempotent).
 */
export async function runCoverageSyncPass(
  deps: CoverageSyncPassDeps,
): Promise<CoverageSyncPassResult> {
  const batchSize =
    deps.batchSize && deps.batchSize > 0 ? deps.batchSize : DEFAULT_COVERAGE_SYNC_BATCH_SIZE;

  const pending = await deps.store.listPendingCoverageSegments(deps.workspaceId);
  let syncedSegments = 0;
  for (let index = 0; index < pending.length; index += batchSize) {
    const chunk = pending.slice(index, index + batchSize);
    await deps.api.submitCoverageBatch({
      segments: chunk.map(toCoverageSegmentInput),
      workspaceId: deps.workspaceId,
    });
    await deps.store.markCoverageSegmentsSynced(chunk.map((segment) => segment.id));
    syncedSegments += chunk.length;
  }

  const liveness = await deps.store.getDeviceCaptureLiveness(deps.workspaceId, deps.deviceId);
  let livenessUpserted = false;
  if (liveness) {
    // The open-segment head is intentionally omitted for now (optional on the
    // server); closed segments carry the authoritative history.
    await deps.api.upsertLiveness({
      desiredState: liveness.desiredState,
      deviceId: liveness.deviceId,
      lastAliveAt: liveness.lastAliveAt,
      workspaceId: liveness.workspaceId,
    });
    livenessUpserted = true;
  }

  return { livenessUpserted, syncedSegments };
}

export type CoverageSyncDriver = {
  start(): void;
  stop(): void;
};

export type CoverageSyncDriverDeps = CoverageSyncPassDeps & {
  intervalMs?: number;
  onError?(error: unknown): void;
  onResult?(result: CoverageSyncPassResult): void;
  setIntervalFn?: (callback: () => void, delayMs: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
};

/**
 * Drives `runCoverageSyncPass` on a low-priority interval. Passes never overlap
 * (a still-running pass skips the next tick) and a failing pass is reported via
 * `onError` without stopping the driver.
 */
export function createCoverageSyncDriver(deps: CoverageSyncDriverDeps): CoverageSyncDriver {
  const intervalMs =
    deps.intervalMs && deps.intervalMs > 0 ? deps.intervalMs : DEFAULT_COVERAGE_SYNC_INTERVAL_MS;
  const setIntervalFn =
    deps.setIntervalFn ?? ((callback, delayMs) => setInterval(callback, delayMs));
  const clearIntervalFn =
    deps.clearIntervalFn ??
    ((handle) => {
      clearInterval(handle as ReturnType<typeof setInterval>);
    });

  let handle: unknown;
  let running = false;
  let inFlight = false;

  async function tick(): Promise<void> {
    if (inFlight) {
      return;
    }

    inFlight = true;
    try {
      const result = await runCoverageSyncPass(deps);
      deps.onResult?.(result);
    } catch (error) {
      deps.onError?.(error);
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      if (running) {
        return;
      }

      running = true;
      handle = setIntervalFn(() => {
        void tick();
      }, intervalMs);
    },
    stop() {
      if (!running) {
        return;
      }

      running = false;
      if (handle !== undefined) {
        clearIntervalFn(handle);
        handle = undefined;
      }
    },
  };
}

function toCoverageSegmentInput(record: CaptureCoverageSegmentRecord): CaptureCoverageSegmentInput {
  return {
    coverageState: record.coverageState,
    deviceId: record.deviceId,
    endedAt: record.endedAt,
    intervalMs: record.intervalMs,
    startedAt: record.startedAt,
    tickCount: record.tickCount,
  };
}

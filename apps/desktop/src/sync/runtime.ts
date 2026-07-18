import { createSyncWorkerCapacity } from './capacity';
import type { SyncWorkerCapacity, SyncWorkerCapacityStatus } from './capacity';
import { createSyncJobExecutor } from './job';
import { createSyncLoop as createRealSyncLoop } from './loop';
import type { SyncLoop, SyncLoopOptions } from './loop';
import { recoverSyncQueue } from './recovery';
import type {
  RetryBackoffConfig,
  SyncAssetReader,
  SyncQueueStore,
  SyncRunResult,
  SyncServerApi,
} from './types';
import { createSyncWorker } from './worker';

const DEFAULT_SYNC_MAX_ATTEMPTS = 15;
const DEFAULT_SYNC_LOCAL_MAX_WORKERS = 4;
const DEFAULT_SYNC_RETRY_BACKOFF: RetryBackoffConfig = {
  baseMs: 2000,
  factor: 2,
  maxMs: 300_000,
  jitterRatio: 0.2,
};

const failClosedReadAssetBytes: SyncAssetReader = async () => {
  throw Object.assign(
    new Error('Real asset bytes are not available for this local asset reference.'),
    {
      code: 'local_asset_unreadable',
      retryable: false,
      safeMessage: 'Local asset is unreadable.',
    },
  );
};

export type SyncRuntimeOptions = {
  createLoop?(options: SyncLoopOptions): SyncLoop;
  createServerApi(): SyncServerApi;
  idleDelayMs?: number;
  activeDelayMs?: number;
  localMaxWorkers?: number;
  maxAttempts?: number;
  now(): string;
  onError?(error: unknown): void;
  onResult?(result: SyncRunResult): void;
  readAssetBytes?: SyncAssetReader;
  retryBackoff?: RetryBackoffConfig;
  resolveServerMaxConcurrentOcr?(): number;
  store: SyncQueueStore;
  workspaceId: string;
};

export type SyncRuntime = SyncLoop & {
  getCapacityStatus(): SyncWorkerCapacityStatus;
  recover(): Promise<void>;
  updateServerMaxConcurrentOcr(value: number): void;
};

export function createSyncRuntime(options: SyncRuntimeOptions): SyncRuntime {
  const localMaxWorkers = positiveInteger(options.localMaxWorkers, DEFAULT_SYNC_LOCAL_MAX_WORKERS);
  let capacity: SyncWorkerCapacity | undefined;
  let serverMaxConcurrentOcr = getServerMaxConcurrentOcr();
  let loops: SyncLoop[] = [];
  let running = false;
  let reconcileTail = Promise.resolve();

  function getServerMaxConcurrentOcr(): number {
    return positiveInteger(options.resolveServerMaxConcurrentOcr?.(), 1);
  }

  function getCapacityStatus(): SyncWorkerCapacityStatus {
    return (
      capacity?.getStatus() ?? {
        activeWorkers: 0,
        localMaxWorkers,
        serverMaxConcurrentOcr,
      }
    );
  }

  function queueReconcile(): void {
    reconcileTail = reconcileTail
      .then(async () => {
        if (!running || !capacity) {
          return;
        }

        const desiredWorkers = capacity.getStatus().activeWorkers;
        const excess = loops.splice(desiredWorkers);
        const additionalWorkers = desiredWorkers - loops.length;

        for (let index = 0; index < additionalWorkers; index += 1) {
          const loop = createWorkerLoop();
          loops.push(loop);
          loop.start();
        }

        await Promise.allSettled(excess.map((loop) => loop.stop()));
      })
      .catch((error) => {
        options.onError?.(error);
      });
  }

  function createWorkerLoop(): SyncLoop {
    const clock = { now: options.now };
    const workspace = { getActiveWorkspaceId: async () => options.workspaceId };
    const maxAttempts = options.maxAttempts ?? DEFAULT_SYNC_MAX_ATTEMPTS;
    const executeJob = createSyncJobExecutor({
      api: options.createServerApi(),
      clock,
      maxAttempts,
      readAssetBytes: options.readAssetBytes ?? failClosedReadAssetBytes,
      retryBackoff: options.retryBackoff ?? DEFAULT_SYNC_RETRY_BACKOFF,
      store: options.store,
      workspace,
    });
    const worker = createSyncWorker({
      clock,
      executeJob,
      maxAttempts,
      store: options.store,
      workspace,
    });
    const createLoop = options.createLoop ?? createRealSyncLoop;
    return createLoop({
      activeDelayMs: options.activeDelayMs,
      idleDelayMs: options.idleDelayMs,
      onError: options.onError,
      onResult: (result) => {
        const change = capacity?.observe(result);
        options.onResult?.(result);
        if (change?.changed) {
          queueReconcile();
        }
      },
      worker,
    });
  }

  return {
    async recover() {
      await recoverSyncQueue({
        api: options.createServerApi(),
        clock: { now: options.now },
        now: options.now(),
        store: options.store,
        workspaceId: options.workspaceId,
      });
    },
    getCapacityStatus,
    start() {
      if (running) {
        return;
      }

      running = true;
      capacity = createSyncWorkerCapacity({
        localMaxWorkers,
        serverMaxConcurrentOcr,
      });
      queueReconcile();
    },
    updateServerMaxConcurrentOcr(value) {
      serverMaxConcurrentOcr = positiveInteger(value, 1);
      const change = capacity?.updateServerMaxConcurrentOcr(serverMaxConcurrentOcr);
      if (change?.changed) {
        queueReconcile();
      }
    },
    async stop() {
      running = false;
      const activeLoops = loops;
      loops = [];
      await Promise.allSettled([reconcileTail, ...activeLoops.map((loop) => loop.stop())]);
    },
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

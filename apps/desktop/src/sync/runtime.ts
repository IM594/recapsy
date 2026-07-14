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
  maxAttempts?: number;
  now(): string;
  onError?(error: unknown): void;
  onResult?(result: SyncRunResult): void;
  readAssetBytes?: SyncAssetReader;
  retryBackoff?: RetryBackoffConfig;
  store: SyncQueueStore;
  workspaceId: string;
};

export type SyncRuntime = SyncLoop & {
  recover(): Promise<void>;
};

export function createSyncRuntime(options: SyncRuntimeOptions): SyncRuntime {
  let loop: SyncLoop | undefined;

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
    start() {
      if (loop) {
        loop.start();
        return;
      }

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
      loop = createLoop({
        activeDelayMs: options.activeDelayMs,
        idleDelayMs: options.idleDelayMs,
        onError: options.onError,
        onResult: options.onResult,
        worker,
      });
      loop.start();
    },
    async stop() {
      await loop?.stop();
    },
  };
}

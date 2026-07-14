import { createSyncLoop as createRealSyncLoop } from './loop';
import type { SyncLoop, SyncLoopOptions } from './loop';
import { recoverInterruptedOutboxJobs } from './recovery';
import { createSyncScheduler } from './scheduler';
import type {
  RetryBackoffConfig,
  SyncAssetReader,
  SyncQueueStore,
  SyncRunResult,
  SyncServerApi,
} from './types';

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
      await recoverInterruptedOutboxJobs({
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

      const scheduler = createSyncScheduler({
        api: options.createServerApi(),
        clock: { now: options.now },
        maxAttempts: options.maxAttempts ?? DEFAULT_SYNC_MAX_ATTEMPTS,
        readAssetBytes: options.readAssetBytes ?? failClosedReadAssetBytes,
        retryBackoff: options.retryBackoff ?? DEFAULT_SYNC_RETRY_BACKOFF,
        store: options.store,
        workspace: { getActiveWorkspaceId: async () => options.workspaceId },
      });
      const createLoop = options.createLoop ?? createRealSyncLoop;
      loop = createLoop({
        activeDelayMs: options.activeDelayMs,
        idleDelayMs: options.idleDelayMs,
        onError: options.onError,
        onResult: options.onResult,
        scheduler,
      });
      loop.start();
    },
    async stop() {
      await loop?.stop();
    },
  };
}

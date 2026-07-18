import { type IpcHandlerMap, createRendererSafeSuccess } from '../ipc/index';
import type { SyncWorkerCapacityStatus } from './capacity';
import { type SyncSummaryStore, createSyncQueueSummary } from './summary';

export type SyncIpcHandlerOptions = {
  getWorkerCapacity?(): SyncWorkerCapacityStatus;
  now?(): string;
  store: SyncSummaryStore;
  workspaceId: string;
};

export function createSyncIpcHandlers(options: SyncIpcHandlerOptions): IpcHandlerMap {
  return {
    'sync.getSummary': async () =>
      createRendererSafeSuccess(
        await createSyncQueueSummary(options.store, options.workspaceId, {
          now: options.now?.(),
          ...(options.getWorkerCapacity ? { workerCapacity: options.getWorkerCapacity() } : {}),
        }),
      ),
  };
}

import { type IpcHandlerMap, createRendererSafeSuccess } from '../ipc/index';
import type { SyncWorkerCapacityStatus } from './capacity';
import type { SyncGateStatus } from './gate';
import { type SyncSummaryStore, createSyncQueueSummary } from './summary';

export type SyncIpcHandlerOptions = {
  getWorkerCapacity?(): SyncWorkerCapacityStatus;
  getGateStatus(): SyncGateStatus;
  now?(): string;
  requeueTerminalJobs(): Promise<number>;
  resumeProviderSync(): void;
  store: SyncSummaryStore;
  workspaceId: string;
};

export function createSyncIpcHandlers(options: SyncIpcHandlerOptions): IpcHandlerMap {
  return {
    'sync.getSummary': async () => {
      const summary = await createSyncQueueSummary(options.store, options.workspaceId, {
        now: options.now?.(),
        ...(options.getWorkerCapacity ? { workerCapacity: options.getWorkerCapacity() } : {}),
      });
      return createRendererSafeSuccess({ ...summary, gate: options.getGateStatus() });
    },
    'sync.resume': async () => {
      options.resumeProviderSync();
      return createRendererSafeSuccess(options.getGateStatus());
    },
    'sync.requeueTerminal': async () =>
      createRendererSafeSuccess({ requeuedJobs: await options.requeueTerminalJobs() }),
  };
}

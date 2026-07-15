import { type IpcHandlerMap, createRendererSafeSuccess } from '../ipc/index';
import { type SyncSummaryStore, createSyncQueueSummary } from './summary';

export type SyncIpcHandlerOptions = {
  store: SyncSummaryStore;
  workspaceId: string;
};

export function createSyncIpcHandlers(options: SyncIpcHandlerOptions): IpcHandlerMap {
  return {
    'sync.getSummary': async () =>
      createRendererSafeSuccess(await createSyncQueueSummary(options.store, options.workspaceId)),
  };
}

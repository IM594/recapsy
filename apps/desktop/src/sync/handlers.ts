import { type IpcHandlerMap, createRendererSafeSuccess } from '../ipc/public';
import { createSyncQueueSummary } from './scheduler';
import type { SyncQueueStore } from './types';

export type SyncIpcHandlerOptions = {
  store: SyncQueueStore;
  workspaceId: string;
};

export function createSyncIpcHandlers(options: SyncIpcHandlerOptions): IpcHandlerMap {
  return {
    'sync.getSummary': async () =>
      createRendererSafeSuccess(await createSyncQueueSummary(options.store, options.workspaceId)),
  };
}

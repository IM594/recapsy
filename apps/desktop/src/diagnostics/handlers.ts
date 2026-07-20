import {
  type IpcHandlerMap,
  createIpcErrorEnvelope,
  createRendererSafeSuccess,
} from '../ipc/index';
import {
  type LocalRetentionExecutionStore,
  executeLocalRetention,
  planLocalRetentionDryRun,
} from '../storage/index';

export type DiagnosticsIpcHandlerOptions = {
  now(): string;
  removeAsset(localAccessKey: string): Promise<void>;
  store: LocalRetentionExecutionStore;
  workspaceId: string;
};

export function createDiagnosticsIpcHandlers(options: DiagnosticsIpcHandlerOptions): IpcHandlerMap {
  let retentionRun: Promise<ReturnType<typeof createRendererSafeSuccess>> | undefined;

  return {
    'diagnostics.previewRetention': async (payload) => {
      const input = payload as { olderThanDays: number };
      return createRendererSafeSuccess(
        await planLocalRetentionDryRun({
          now: options.now(),
          olderThanDays: input.olderThanDays,
          store: options.store,
          workspaceId: options.workspaceId,
        }),
      );
    },
    'diagnostics.runRetention': async (payload) => {
      if (retentionRun) {
        return createIpcErrorEnvelope('unknown', 'Retention cleanup is already running.');
      }

      const input = payload as { olderThanDays: number };
      retentionRun = executeLocalRetention({
        now: options.now(),
        olderThanDays: input.olderThanDays,
        removeAsset: options.removeAsset,
        store: options.store,
        workspaceId: options.workspaceId,
      }).then(createRendererSafeSuccess);

      try {
        return await retentionRun;
      } catch {
        return createIpcErrorEnvelope('unknown', 'Local asset cleanup failed.');
      } finally {
        retentionRun = undefined;
      }
    },
  };
}

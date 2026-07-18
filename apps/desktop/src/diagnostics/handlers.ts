import { type IpcHandlerMap, createRendererSafeSuccess } from '../ipc/index';
import { type LocalRetentionDryRunStore, planLocalRetentionDryRun } from '../storage/index';

export type DiagnosticsIpcHandlerOptions = {
  now(): string;
  store: LocalRetentionDryRunStore;
  workspaceId: string;
};

export function createDiagnosticsIpcHandlers(options: DiagnosticsIpcHandlerOptions): IpcHandlerMap {
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
  };
}

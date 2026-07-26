import type {
  ClaimRetryableOutboxJobInput,
  OperationalStoreResult,
  OutboxJob,
  OutboxTerminalUpdate,
} from '../storage/index';
import { type SyncGate, createSyncGate } from './gate';
import type { SyncJobExecutor } from './job';
import type { SyncCancelResult, SyncClock, SyncRunResult, SyncWorkspaceProvider } from './types';

export type SyncWorkerStore = {
  claimNextRetryableOutboxJob(input: ClaimRetryableOutboxJobInput): Promise<OutboxJob | null>;
  getOutboxJob(id: string): Promise<OutboxJob | null>;
  markOutboxJobTerminal(
    id: string,
    update: OutboxTerminalUpdate,
  ): Promise<OperationalStoreResult<OutboxJob>>;
};

export type SyncWorkerOptions = {
  clock: SyncClock;
  executeJob: SyncJobExecutor;
  gate?: SyncGate;
  maxAttempts: number;
  store: SyncWorkerStore;
  workspace: SyncWorkspaceProvider;
};

export function createSyncWorker(options: SyncWorkerOptions) {
  const gate = options.gate ?? createSyncGate();
  return {
    async cancel(jobId: string, reason: string): Promise<SyncCancelResult> {
      const job = await options.store.getOutboxJob(jobId);

      if (!job) {
        return { cancelled: false, jobId };
      }

      if (job.state === 'cancelled') {
        return { cancelled: true, jobId };
      }

      if (['synced', 'blocked', 'failed'].includes(job.state)) {
        return { cancelled: false, jobId };
      }

      // The thin-proxy model has no remote OCR job to cancel. A local terminal
      // state is sufficient to stop future claims and result submission.
      const terminal = await options.store.markOutboxJobTerminal(job.id, {
        leaseToken: job.leaseToken,
        now: options.clock.now(),
        reason,
        serverCaptureId: job.serverCaptureId,
        state: 'cancelled',
      });

      if (!terminal.ok) {
        return { cancelled: false, jobId };
      }

      return { cancelled: true, jobId };
    },
    async runOnce(): Promise<SyncRunResult> {
      const workspaceId = await options.workspace.getActiveWorkspaceId();

      if (!workspaceId) {
        return {
          code: 'workspace_required',
          processed: 0,
          status: 'skipped',
        };
      }

      if (!gate.tryEnter(options.clock.now())) {
        return {
          code: 'sync_paused',
          processed: 0,
          status: 'skipped',
        };
      }

      const job = await options.store.claimNextRetryableOutboxJob({
        maxAttempts: options.maxAttempts,
        now: options.clock.now(),
        workspaceId,
      });

      if (!job) {
        const result: SyncRunResult = {
          processed: 0,
          status: 'idle',
        };
        gate.observe(result, options.clock.now());
        return result;
      }

      const result = await options.executeJob(job);
      gate.observe(result, options.clock.now());
      return result;
    },
  };
}

import type { OutboxJob, SafeOperationalError } from '../storage/index';
import { reconcileOutboxJobFromServerCapture } from './reconciliation';
import type { SyncClock, SyncQueueStore, SyncServerApi } from './types';

export type SyncRecoveryOptions = {
  store: SyncQueueStore;
  now: string;
  workspaceId?: string;
  api?: Pick<SyncServerApi, 'getCapture'>;
  clock?: SyncClock;
};

export type SyncRecoverySummary = {
  scanned: number;
  recovered: number;
  syncInterrupted: number;
  resultSubmitInterrupted: number;
  reconciledSynced: number;
};

const STARTUP_RECOVERY_ERRORS = {
  interrupted_during_sync: {
    code: 'interrupted_during_sync',
    message: 'Outbox sync was interrupted before startup recovery.',
    retryable: true,
  },
  interrupted_before_result_submit: {
    code: 'interrupted_before_result_submit',
    message: 'OCR result submission was interrupted before startup recovery.',
    retryable: true,
  },
} satisfies Record<string, SafeOperationalError>;

export async function recoverSyncQueue(options: SyncRecoveryOptions): Promise<SyncRecoverySummary> {
  const jobs = await options.store.listInterruptedOutboxJobs(options.workspaceId);
  const summary: SyncRecoverySummary = {
    reconciledSynced: 0,
    recovered: 0,
    resultSubmitInterrupted: 0,
    scanned: jobs.length,
    syncInterrupted: 0,
  };

  for (const job of jobs) {
    // A recovered `result_pending` job already holds its transcript locally, so
    // it replays as a submit-only retry (no billed proxy re-run) — the
    // job executor's fast path handles the resubmission. See
    // `docs/design/OCR_OUTBOX_STATE_MACHINE.md` §3.2.
    if (job.state === 'result_pending') {
      await recoverJob(options, job, STARTUP_RECOVERY_ERRORS.interrupted_before_result_submit);
      summary.recovered += 1;
      summary.resultSubmitInterrupted += 1;
      continue;
    }

    // `syncing`: create/proxy/submit was in flight when the process stopped. If
    // the server already finished OCR for an already-created capture, settle
    // it; otherwise recover for a full replay (create is idempotent).
    if (options.api && job.serverCaptureId) {
      const reconciled = await reconcileInterruptedCaptureJob(options, job, summary);
      if (reconciled) {
        continue;
      }
    }

    await recoverJob(options, job, STARTUP_RECOVERY_ERRORS.interrupted_during_sync);
    summary.recovered += 1;
    summary.syncInterrupted += 1;
  }

  return summary;
}

async function reconcileInterruptedCaptureJob(
  options: SyncRecoveryOptions,
  job: OutboxJob,
  summary: SyncRecoverySummary,
): Promise<boolean> {
  if (!options.api) {
    return false;
  }

  const clock = options.clock ?? { now: () => options.now };
  const reconciled = await reconcileOutboxJobFromServerCapture(
    {
      api: options.api,
      clock,
      store: options.store,
    },
    job,
  );

  if (reconciled) {
    if (reconciled.status === 'synced') {
      summary.recovered += 1;
      summary.reconciledSynced += 1;
    }
    return true;
  }

  return false;
}

async function recoverJob(
  options: SyncRecoveryOptions,
  job: OutboxJob,
  lastSafeError: SafeOperationalError,
): Promise<void> {
  const result = await options.store.recoverInterruptedOutboxJob({
    id: job.id,
    lastSafeError,
    leaseToken: job.leaseToken,
    nextRetryAt: options.now,
    now: options.now,
  });

  if (!result.ok) {
    throw new Error(`Startup recovery failed for interrupted outbox job: ${result.error.code}`);
  }
}

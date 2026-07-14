import type { OutboxJob, SafeOperationalError } from '../storage/public';
import { reconcileOutboxJobFromServerCapture } from './reconciliation';
import type { SyncClock, SyncQueueStore, SyncServerApi } from './types';

export type StartupRecoveryOptions = {
  store: SyncQueueStore;
  now: string;
  workspaceId?: string;
  api?: Pick<SyncServerApi, 'getCapture'>;
  clock?: SyncClock;
};

export type StartupRecoverySummary = {
  scanned: number;
  recovered: number;
  syncInterrupted: number;
  resultSubmitInterrupted: number;
  reconciledSynced: number;
  unchangedRetryable: number;
  unchangedTerminal: number;
};

const TERMINAL_OUTBOX_STATES = new Set<OutboxJob['state']>([
  'synced',
  'blocked',
  'failed',
  'cancelled',
]);

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

export async function recoverInterruptedOutboxJobs(
  options: StartupRecoveryOptions,
): Promise<StartupRecoverySummary> {
  const jobs = await options.store.listOutboxJobs(
    options.workspaceId ? { workspaceId: options.workspaceId } : undefined,
  );
  const summary: StartupRecoverySummary = {
    reconciledSynced: 0,
    recovered: 0,
    resultSubmitInterrupted: 0,
    scanned: jobs.length,
    syncInterrupted: 0,
    unchangedRetryable: 0,
    unchangedTerminal: 0,
  };

  for (const job of jobs) {
    if (TERMINAL_OUTBOX_STATES.has(job.state)) {
      summary.unchangedTerminal += 1;
      continue;
    }

    if (job.state === 'pending') {
      summary.unchangedRetryable += 1;
      continue;
    }

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

    // `syncing`: ingest/proxy/submit was in flight when the process stopped. If
    // the server already finished OCR for an already-ingested capture, settle
    // it; otherwise recover for a full replay (ingest is idempotent).
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
  options: StartupRecoveryOptions,
  job: OutboxJob,
  summary: StartupRecoverySummary,
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

  if (reconciled?.status === 'synced') {
    summary.recovered += 1;
    summary.reconciledSynced += 1;
    return true;
  }

  return false;
}

async function recoverJob(
  options: StartupRecoveryOptions,
  job: OutboxJob,
  lastSafeError: SafeOperationalError,
): Promise<void> {
  const result = await options.store.recoverInterruptedOutboxJob({
    id: job.id,
    lastSafeError,
    nextRetryAt: options.now,
    now: options.now,
  });

  if (!result.ok) {
    throw new Error(`Startup recovery failed for interrupted outbox job: ${result.error.code}`);
  }
}

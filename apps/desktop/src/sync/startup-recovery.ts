import type { ServerApiClient } from '../server-api/types';
import type { OperationalStoreRepository, OutboxJob, SafeOperationalError } from '../storage';
import { reconcileOutboxJobFromServerCapture } from './scheduler';
import type { SyncClock } from './types';

export type StartupRecoveryOptions = {
  store: OperationalStoreRepository;
  now: string;
  workspaceId?: string;
  api?: Pick<ServerApiClient, 'getCapture'>;
  clock?: SyncClock;
};

export type StartupRecoverySummary = {
  scanned: number;
  recovered: number;
  uploadPending: number;
  ocrPolling: number;
  ocrPendingWithoutServerJob: number;
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
  interrupted_during_upload: {
    code: 'interrupted_during_upload',
    message: 'Outbox upload was interrupted before startup recovery.',
    retryable: true,
  },
  interrupted_while_waiting_for_ocr: {
    code: 'interrupted_while_waiting_for_ocr',
    message: 'OCR polling was interrupted before startup recovery.',
    retryable: true,
  },
  interrupted_without_server_job: {
    code: 'interrupted_without_server_job',
    message: 'OCR wait state was missing a server job before startup recovery.',
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
    ocrPendingWithoutServerJob: 0,
    ocrPolling: 0,
    reconciledSynced: 0,
    recovered: 0,
    scanned: jobs.length,
    unchangedRetryable: 0,
    unchangedTerminal: 0,
    uploadPending: 0,
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

    if (options.api && job.serverCaptureId && !job.serverOcrJobId) {
      const reconciled = await reconcileInterruptedCaptureJob(options, job, summary);
      if (reconciled) {
        continue;
      }
    }

    if (job.state === 'uploading') {
      await recoverJob(options, job, STARTUP_RECOVERY_ERRORS.interrupted_during_upload);
      summary.recovered += 1;
      summary.uploadPending += 1;
      continue;
    }

    if (job.state === 'ocr_wait' && job.serverOcrJobId) {
      await recoverJob(options, job, STARTUP_RECOVERY_ERRORS.interrupted_while_waiting_for_ocr);
      summary.recovered += 1;
      summary.ocrPolling += 1;
      continue;
    }

    if (job.state === 'ocr_wait') {
      await recoverJob(options, job, STARTUP_RECOVERY_ERRORS.interrupted_without_server_job);
      summary.recovered += 1;
      summary.ocrPendingWithoutServerJob += 1;
    }
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

  const refreshed = await options.store.getOutboxJob(job.id);
  if (!refreshed?.serverOcrJobId) {
    return false;
  }

  await recoverJob(options, refreshed, STARTUP_RECOVERY_ERRORS.interrupted_while_waiting_for_ocr);
  summary.recovered += 1;
  summary.ocrPolling += 1;
  return true;
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

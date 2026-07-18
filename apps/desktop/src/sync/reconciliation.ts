import type { OperationalStoreResult, OutboxJob } from '../storage/index';
import type { SyncRunResult } from './types';

type ReconciliationJob = Pick<
  OutboxJob,
  'id' | 'leaseToken' | 'serverCaptureId' | 'state' | 'workspaceId'
>;

type ServerCaptureOcrStatus =
  | 'not_requested'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'blocked';

export type ServerCaptureReconciliationApi = {
  getCapture(
    workspaceId: string,
    captureId: string,
  ): Promise<{ ocrStatus: ServerCaptureOcrStatus }>;
};

export type ServerCaptureReconciliationClock = {
  now(): string;
};

export type ServerCaptureReconciliationStore = {
  getOutboxJob(id: string): Promise<OutboxJob | null>;
  markOutboxJobTerminal(
    id: string,
    update: {
      now: string;
      leaseToken?: string;
      reason: 'ocr_synced';
      serverCaptureId: string;
      state: 'synced';
    },
  ): Promise<OperationalStoreResult<OutboxJob>>;
};

type ServerCaptureReconciliationOptions = {
  api: ServerCaptureReconciliationApi;
  clock: ServerCaptureReconciliationClock;
  store: ServerCaptureReconciliationStore;
};

/**
 * Best-effort reconciliation used on replay and at startup recovery: if the
 * server already reports the capture's OCR as succeeded, settle the local job
 * as `synced` without re-running the proxy (idempotent guard against a crash
 * between a successful submit and the local terminal write). Returns null when
 * there is nothing to settle.
 */
export async function reconcileOutboxJobFromServerCapture(
  options: ServerCaptureReconciliationOptions,
  job: ReconciliationJob,
): Promise<SyncRunResult | null> {
  if (!job.serverCaptureId) {
    return null;
  }

  if (['synced', 'blocked', 'failed', 'cancelled'].includes(job.state)) {
    return null;
  }

  const capture = await options.api.getCapture(job.workspaceId, job.serverCaptureId);

  if (capture.ocrStatus !== 'succeeded') {
    return null;
  }

  const terminal = await options.store.markOutboxJobTerminal(job.id, {
    leaseToken: job.leaseToken,
    now: options.clock.now(),
    reason: 'ocr_synced',
    serverCaptureId: job.serverCaptureId,
    state: 'synced',
  });

  if (!terminal.ok) {
    const current = await options.store.getOutboxJob(job.id);
    if (current?.state === 'synced' && current.serverCaptureId === job.serverCaptureId) {
      return { jobId: job.id, processed: 1, status: 'synced' };
    }
    return {
      ...(terminal.error.code === 'outbox_lease_lost' ? { code: 'lease_lost' as const } : {}),
      jobId: job.id,
      processed: 0,
      status: 'skipped',
    };
  }

  return { jobId: job.id, processed: 1, status: 'synced' };
}

import type { OutboxJob } from '../storage/index';
import type { SyncRunResult } from './types';

type ReconciliationJob = Pick<OutboxJob, 'id' | 'serverCaptureId' | 'state' | 'workspaceId'>;

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
  markOutboxJobTerminal(
    id: string,
    update: {
      now: string;
      reason: 'ocr_synced';
      serverCaptureId: string;
      state: 'synced';
    },
  ): Promise<unknown>;
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

  await options.store.markOutboxJobTerminal(job.id, {
    now: options.clock.now(),
    reason: 'ocr_synced',
    serverCaptureId: job.serverCaptureId,
    state: 'synced',
  });

  return { jobId: job.id, processed: 1, status: 'synced' };
}

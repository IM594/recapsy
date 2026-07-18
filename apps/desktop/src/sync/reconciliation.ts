import type {
  OutboxJobState,
  ServerCaptureSettlement,
  ServerCaptureSettlementInput,
} from '../storage/index';
import type { SyncRunResult } from './types';

type ReconciliationJob = {
  id: string;
  leaseToken?: string;
  serverCaptureId?: string;
  state: OutboxJobState;
  workspaceId: string;
};

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
  settleServerCapture(input: ServerCaptureSettlementInput): Promise<ServerCaptureSettlement>;
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

  const settlement = await options.store.settleServerCapture({
    id: job.id,
    leaseToken: job.leaseToken,
    now: options.clock.now(),
    serverCaptureId: job.serverCaptureId,
  });

  if (settlement.status === 'skipped') {
    return {
      ...(settlement.code ? { code: settlement.code } : {}),
      jobId: job.id,
      processed: 0,
      status: 'skipped',
    };
  }

  return { jobId: job.id, processed: 1, status: 'synced' };
}

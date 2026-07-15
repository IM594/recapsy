import type { BackpressureDecision, OutboxJob } from '../storage/index';
import { toSyncPresentationError } from './errors';
import type { SyncQueueSummary } from './types';

type SummaryOutboxJob = Pick<OutboxJob, 'lastSafeError' | 'nextRetryAt' | 'state'>;

export type SyncSummaryStore = {
  listOutboxJobs(filter: { workspaceId: string }): Promise<SummaryOutboxJob[]>;
};

export async function createSyncQueueSummary(
  store: SyncSummaryStore,
  workspaceId: string,
  options: {
    backpressure?: BackpressureDecision;
  } = {},
): Promise<SyncQueueSummary> {
  const jobs = await store.listOutboxJobs({ workspaceId });
  const nextRetryAt = jobs
    .map((job) => job.nextRetryAt)
    .filter((value): value is string => typeof value === 'string')
    .sort()[0];
  const lastSafeError = [...jobs].reverse().find((job) => job.lastSafeError)?.lastSafeError;

  return {
    blocked: jobs.filter((job) => job.state === 'blocked').length,
    failed: jobs.filter((job) => job.state === 'failed').length,
    pending: jobs.filter((job) => job.state === 'pending').length,
    retrying: jobs.filter((job) => job.state === 'pending' && job.nextRetryAt).length,
    syncing: jobs.filter((job) => job.state === 'syncing' || job.state === 'result_pending').length,
    ...(options.backpressure
      ? {
          backpressure: {
            active: options.backpressure.action === 'pause',
            reasons: [...options.backpressure.reasons],
          },
        }
      : {}),
    ...(lastSafeError
      ? {
          lastError: toSyncPresentationError(lastSafeError),
        }
      : {}),
    ...(nextRetryAt ? { nextRetryAt } : {}),
  };
}

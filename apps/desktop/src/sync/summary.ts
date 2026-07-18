import type { BackpressureDecision, OutboxJob } from '../storage/index';
import type { SyncWorkerCapacityStatus } from './capacity';
import { toSyncPresentationError } from './errors';
import type { SyncQueueSummary } from './types';

type SummaryOutboxJob = Pick<
  OutboxJob,
  'createdAt' | 'lastSafeError' | 'nextRetryAt' | 'state' | 'updatedAt'
>;

export type SyncSummaryStore = {
  listOutboxJobs(filter: { workspaceId: string }): Promise<SummaryOutboxJob[]>;
};

export async function createSyncQueueSummary(
  store: SyncSummaryStore,
  workspaceId: string,
  options: {
    backpressure?: BackpressureDecision;
    now?: string;
    workerCapacity?: SyncWorkerCapacityStatus;
  } = {},
): Promise<SyncQueueSummary> {
  const jobs = await store.listOutboxJobs({ workspaceId });
  const now = parseTimestamp(options.now ?? new Date().toISOString()) ?? Date.now();
  const minuteAgo = now - 60_000;
  const activeJobTimes = jobs
    .filter(isActiveJob)
    .map((job) => parseTimestamp(job.createdAt))
    .filter((value): value is number => value !== null);
  const nextRetryAt = jobs
    .map((job) => job.nextRetryAt)
    .filter((value): value is string => typeof value === 'string')
    .sort()[0];
  const lastSafeError = [...jobs].reverse().find((job) => job.lastSafeError)?.lastSafeError;

  return {
    blocked: jobs.filter((job) => job.state === 'blocked').length,
    completedPerMinute: jobs.filter(
      (job) => job.state === 'synced' && isWithinMinute(job.updatedAt, minuteAgo, now),
    ).length,
    failed: jobs.filter((job) => job.state === 'failed').length,
    inputPerMinute: jobs.filter((job) => isWithinMinute(job.createdAt, minuteAgo, now)).length,
    pending: jobs.filter((job) => job.state === 'pending').length,
    processing: jobs.filter((job) => job.state === 'syncing' || job.state === 'result_pending')
      .length,
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
    ...(activeJobTimes.length > 0
      ? {
          oldestActiveAgeSeconds: Math.max(
            0,
            Math.floor((now - Math.min(...activeJobTimes)) / 1000),
          ),
        }
      : {}),
    ...(options.workerCapacity
      ? {
          workerCapacity: { ...options.workerCapacity },
        }
      : {}),
  };
}

function isActiveJob(job: SummaryOutboxJob): boolean {
  return job.state === 'pending' || job.state === 'syncing' || job.state === 'result_pending';
}

function isWithinMinute(value: string, minuteAgo: number, now: number): boolean {
  const timestamp = parseTimestamp(value);
  return timestamp !== null && timestamp >= minuteAgo && timestamp <= now;
}

function parseTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

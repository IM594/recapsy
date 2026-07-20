import type { BackpressureDecision, OutboxJob, OutboxQueueSummary } from '../storage/index';
import type { SyncWorkerCapacityStatus } from './capacity';
import { toSyncPresentationError } from './errors';
import type { SyncQueueSummary } from './types';

type SummaryOutboxJob = Pick<
  OutboxJob,
  'createdAt' | 'lastSafeError' | 'nextRetryAt' | 'state' | 'updatedAt'
>;

export type SyncSummaryStore = {
  getOutboxSummary?(input: {
    minuteAgo: string;
    now: string;
    workspaceId: string;
  }): Promise<OutboxQueueSummary>;
  listOutboxJobs?(filter: { workspaceId: string }): Promise<SummaryOutboxJob[]>;
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
  const requestedNow = options.now ?? new Date().toISOString();
  const now = parseTimestamp(requestedNow) ?? Date.now();
  const minuteAgo = now - 60_000;
  const snapshot = await readSummary(store, workspaceId, {
    minuteAgo: new Date(minuteAgo).toISOString(),
    now: new Date(now).toISOString(),
  });
  const oldestActiveAt = snapshot.oldestActiveCreatedAt
    ? parseTimestamp(snapshot.oldestActiveCreatedAt)
    : null;

  return {
    blocked: snapshot.blocked,
    completedPerMinute: snapshot.completedPerMinute,
    failed: snapshot.failed,
    inputPerMinute: snapshot.inputPerMinute,
    pending: snapshot.pending,
    processing: snapshot.processing,
    retrying: snapshot.retrying,
    syncing: snapshot.syncing,
    ...(options.backpressure
      ? {
          backpressure: {
            active: options.backpressure.action === 'pause',
            reasons: [...options.backpressure.reasons],
          },
        }
      : {}),
    ...(snapshot.lastSafeError
      ? {
          lastError: toSyncPresentationError(snapshot.lastSafeError),
        }
      : {}),
    ...(snapshot.nextRetryAt ? { nextRetryAt: snapshot.nextRetryAt } : {}),
    ...(oldestActiveAt !== null
      ? {
          oldestActiveAgeSeconds: Math.max(0, Math.floor((now - oldestActiveAt) / 1000)),
        }
      : {}),
    ...(options.workerCapacity
      ? {
          workerCapacity: { ...options.workerCapacity },
        }
      : {}),
  };
}

async function readSummary(
  store: SyncSummaryStore,
  workspaceId: string,
  input: { minuteAgo: string; now: string },
): Promise<OutboxQueueSummary> {
  if (store.getOutboxSummary) {
    return await store.getOutboxSummary({ ...input, workspaceId });
  }
  if (!store.listOutboxJobs) {
    throw new Error('Sync summary store does not provide an outbox summary reader.');
  }

  const jobs = await store.listOutboxJobs({ workspaceId });
  const minuteAgo = Date.parse(input.minuteAgo);
  const now = Date.parse(input.now);
  const activeJobTimes = jobs
    .filter(isActiveJob)
    .map((job) => parseTimestamp(job.createdAt))
    .filter((value): value is number => value !== null);
  const nextRetryAt = jobs
    .filter((job) => job.state === 'pending')
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
    ...(lastSafeError ? { lastSafeError } : {}),
    ...(nextRetryAt ? { nextRetryAt } : {}),
    ...(activeJobTimes.length > 0
      ? { oldestActiveCreatedAt: new Date(Math.min(...activeJobTimes)).toISOString() }
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

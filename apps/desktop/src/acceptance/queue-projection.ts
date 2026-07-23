import type { DevAcceptanceLocalStage, DevAcceptanceSafeErrorCode } from '@recapsy/contracts';
import {
  DevAcceptanceAppNameSchema,
  DevAcceptanceJobIdSchema,
  DevAcceptanceSafeErrorCodeSchema,
} from '@recapsy/contracts';
import type { OutboxJob, OutboxJobState } from '../storage/index';

export type AcceptanceOutboxJob = {
  id: string;
  state: OutboxJobState;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  nextRetryAt?: string;
  serverCaptureId?: string;
  ocrResult?: OutboxJob['ocrResult'];
  lastSafeError?: OutboxJob['lastSafeError'];
  capture?: { appName?: string };
};

export type AcceptanceJobSummary = {
  localJobId: string;
  serverCaptureId: string | null;
  appName: string | null;
  localStage: DevAcceptanceLocalStage;
  attempt: number;
  ageSeconds: number;
  safeErrorCode: DevAcceptanceSafeErrorCode | null;
  createdAt: string;
  updatedAt: string;
  nextRetryAt: string | null;
};

export type AcceptanceQueueProjection = {
  queue: {
    pending: number;
    syncing: number;
    resultPending: number;
    retrying: number;
    failed: number;
    blocked: number;
  };
  processing: number;
  pending: number;
  inFlight: AcceptanceJobSummary[];
  queueHeads: AcceptanceJobSummary[];
  oldestActiveAgeSeconds?: number;
  safeErrorCode?: string;
};

const IN_FLIGHT_LIMIT = 8;
const QUEUE_HEAD_LIMIT = 24;

export function projectAcceptanceQueue(
  jobs: readonly AcceptanceOutboxJob[],
  nowMs: number,
): AcceptanceQueueProjection {
  const pending = jobs.filter((job) => job.state === 'pending');
  const syncing = jobs.filter((job) => job.state === 'syncing');
  const resultPending = jobs.filter((job) => job.state === 'result_pending');
  const retrying = pending.filter((job) => Boolean(job.nextRetryAt));
  const failed = jobs.filter((job) => job.state === 'failed');
  const blocked = jobs.filter((job) => job.state === 'blocked');

  const inFlight = [...syncing, ...resultPending]
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .slice(0, IN_FLIGHT_LIMIT)
    .map((job) => toSummary(job, nowMs));

  const recentSynced = sortByUpdatedDesc(jobs.filter((job) => job.state === 'synced')).slice(0, 12);
  const queueHeads = [
    ...recentSynced,
    ...sortByUpdatedDesc(failed),
    ...sortByUpdatedDesc(blocked),
    ...sortByUpdatedDesc(retrying),
    ...sortByUpdatedDesc(pending.filter((job) => !job.nextRetryAt)),
  ]
    .slice(0, QUEUE_HEAD_LIMIT)
    .map((job) => toSummary(job, nowMs));

  const activeTimes = [...pending, ...syncing, ...resultPending]
    .map((job) => Date.parse(job.createdAt))
    .filter((value) => Number.isFinite(value));

  const lastSafeError = [...jobs].reverse().find((job) => job.lastSafeError)?.lastSafeError?.code;

  return {
    queue: {
      pending: pending.length,
      syncing: syncing.length,
      resultPending: resultPending.length,
      retrying: retrying.length,
      failed: failed.length,
      blocked: blocked.length,
    },
    processing: syncing.length + resultPending.length,
    pending: pending.length,
    inFlight,
    queueHeads,
    ...(activeTimes.length > 0
      ? {
          oldestActiveAgeSeconds: Math.max(
            0,
            Math.floor((nowMs - Math.min(...activeTimes)) / 1000),
          ),
        }
      : {}),
    ...(lastSafeError ? { safeErrorCode: lastSafeError } : {}),
  };
}

export function deriveLocalStage(job: AcceptanceOutboxJob): DevAcceptanceLocalStage {
  switch (job.state as OutboxJobState) {
    case 'pending':
      return job.nextRetryAt ? 'retry_wait' : 'queued';
    case 'syncing':
      if (!job.serverCaptureId) return 'creating_capture';
      if (!job.ocrResult) return 'running_ocr';
      return 'submitting_result';
    case 'result_pending':
      return 'submitting_result';
    case 'synced':
      return 'synced';
    case 'failed':
      return 'failed';
    case 'blocked':
      return 'blocked';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'queued';
  }
}

function toSummary(job: AcceptanceOutboxJob, nowMs: number): AcceptanceJobSummary {
  const anchor = job.state === 'synced' ? Date.parse(job.updatedAt) : Date.parse(job.createdAt);
  const ageSeconds = Number.isFinite(anchor) ? Math.max(0, Math.floor((nowMs - anchor) / 1000)) : 0;
  const localJobId = DevAcceptanceJobIdSchema.safeParse(job.id).success ? job.id : 'job:invalid';
  const appNameParsed = DevAcceptanceAppNameSchema.safeParse(job.capture?.appName ?? '');
  const safeError = job.lastSafeError?.code
    ? DevAcceptanceSafeErrorCodeSchema.safeParse(job.lastSafeError.code)
    : null;

  return {
    localJobId,
    serverCaptureId: job.serverCaptureId ?? null,
    appName: appNameParsed.success ? appNameParsed.data : null,
    localStage: deriveLocalStage(job),
    attempt: Math.max(0, job.attempt),
    ageSeconds,
    safeErrorCode: safeError?.success ? safeError.data : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    nextRetryAt: job.nextRetryAt ?? null,
  };
}

function sortByUpdatedDesc(jobs: AcceptanceOutboxJob[]) {
  return [...jobs].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

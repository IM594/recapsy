import { describe, expect, it } from 'bun:test';
import { createMemoryStore } from '../../storage';
import type { OutboxJob, OutboxJobCreateInput } from '../../storage';
import { createSyncGate } from '../gate';
import { createSyncQueueSummary } from '../summary';
import { createSyncWorker } from '../worker';

const now = '2026-07-06T00:00:00.000Z';

describe('desktop sync worker', () => {
  it('skips claiming work when the active workspace is missing', async () => {
    const store = createMemoryStore();
    await seedJob(store);
    let executeCalls = 0;
    const worker = createWorker(store, {
      executeJob: async () => {
        executeCalls += 1;
        return { processed: 1, status: 'synced' };
      },
      workspaceId: null,
    });

    const result = await worker.runOnce();

    expect(result).toEqual({
      code: 'workspace_required',
      processed: 0,
      status: 'skipped',
    });
    expect(executeCalls).toBe(0);
    expect(await store.getOutboxJob('job_1')).toMatchObject({ state: 'pending' });
  });

  it('returns idle when no retryable job can be claimed', async () => {
    const store = createMemoryStore();
    const worker = createWorker(store);

    const result = await worker.runOnce();

    expect(result).toEqual({ processed: 0, status: 'idle' });
  });

  it('delegates exactly one claimed job to the job executor', async () => {
    const store = createMemoryStore();
    await seedJob(store);
    const executedJobs: OutboxJob[] = [];
    const worker = createWorker(store, {
      executeJob: async (job) => {
        executedJobs.push(job);
        return { jobId: job.id, processed: 1, status: 'retry_wait' };
      },
    });

    const result = await worker.runOnce();

    expect(result).toEqual({ jobId: 'job_1', processed: 1, status: 'retry_wait' });
    expect(executedJobs).toHaveLength(1);
    expect(executedJobs[0]).toMatchObject({
      attempt: 0,
      id: 'job_1',
      state: 'syncing',
      workspaceId: 'workspace_1',
    });
  });

  it('does not claim while provider sync is paused and permits one half-open probe', async () => {
    const store = createMemoryStore();
    await seedJob(store);
    const gate = createSyncGate({ probeDelayMs: 60_000 });
    gate.pause('provider_auth_failed', now);
    let currentTime = now;
    let executeCalls = 0;
    const worker = createSyncWorker({
      clock: { now: () => currentTime },
      executeJob: async (job) => {
        executeCalls += 1;
        return {
          code: 'provider_auth_failed',
          jobId: job.id,
          processed: 1,
          status: 'retry_wait',
        };
      },
      gate,
      maxAttempts: 3,
      store,
      workspace: { getActiveWorkspaceId: async () => 'workspace_1' },
    });

    expect(await worker.runOnce()).toEqual({
      code: 'sync_paused',
      processed: 0,
      status: 'skipped',
    });
    expect(executeCalls).toBe(0);
    expect(await store.getOutboxJob('job_1')).toMatchObject({ state: 'pending' });

    currentTime = '2026-07-06T00:01:00.000Z';
    expect(await worker.runOnce()).toMatchObject({
      code: 'provider_auth_failed',
      status: 'retry_wait',
    });
    expect(executeCalls).toBe(1);
    expect(gate.getStatus()).toMatchObject({ state: 'paused' });
  });

  it('cancels a syncing job as a purely local terminal state', async () => {
    const store = createMemoryStore();
    await seedJob(store);
    await store.updateOutboxJobState('job_1', {
      now,
      serverCaptureId: 'capture_1',
      state: 'syncing',
    });
    const worker = createWorker(store);

    const result = await worker.cancel('job_1', 'user_cancelled');
    const claimed = await store.claimNextRetryableOutboxJob({
      maxAttempts: 3,
      now: '2026-07-06T00:02:00.000Z',
      workspaceId: 'workspace_1',
    });

    expect(result).toEqual({ cancelled: true, jobId: 'job_1' });
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      state: 'cancelled',
      terminalReason: 'user_cancelled',
    });
    expect(claimed).toBeNull();
  });

  it('keeps queue summaries safe after a local cancel under capture backpressure', async () => {
    const store = createMemoryStore();
    await seedJob(store);
    await store.updateOutboxJobState('job_1', {
      now,
      serverCaptureId: 'capture_1',
      state: 'syncing',
    });
    const worker = createWorker(store);

    const result = await worker.cancel('job_1', 'user_cancelled');
    const summary = await createSyncQueueSummary(store, 'workspace_1', {
      backpressure: {
        action: 'pause',
        hardLimit: true,
        reasons: ['max_queued_jobs_reached'],
      },
    });
    const serialized = JSON.stringify(summary);

    expect(result).toEqual({ cancelled: true, jobId: 'job_1' });
    expect(summary).toMatchObject({
      backpressure: {
        active: true,
        reasons: ['max_queued_jobs_reached'],
      },
      pending: 0,
    });
    expect(serialized).not.toContain('/Users/');
    expect(serialized).not.toContain('token');
  });
});

function createWorker(
  store: ReturnType<typeof createMemoryStore>,
  overrides: {
    executeJob?: (job: OutboxJob) => Promise<{
      jobId?: string;
      processed: number;
      status: 'synced' | 'retry_wait';
    }>;
    workspaceId?: string | null;
  } = {},
) {
  return createSyncWorker({
    clock: { now: () => now },
    executeJob:
      overrides.executeJob ??
      (async (job) => ({ jobId: job.id, processed: 1, status: 'synced' as const })),
    maxAttempts: 3,
    store,
    workspace: {
      getActiveWorkspaceId: async () =>
        Object.hasOwn(overrides, 'workspaceId') ? (overrides.workspaceId ?? null) : 'workspace_1',
    },
  });
}

async function seedJob(store: ReturnType<typeof createMemoryStore>) {
  const created = await store.createOutboxJob(createJob());
  expect(created.ok).toBe(true);
}

function createJob(): OutboxJobCreateInput {
  return {
    assetRefId: 'asset_ref_1',
    capture: {
      appName: 'Code',
      captureType: 'screen',
      capturedAt: now,
      observedAt: now,
      privacyDecision: {
        action: 'allow',
        decidedAt: now,
        policyVersion: 'policy_desktop_1',
        reasons: [],
      },
    },
    createdAt: now,
    deviceId: 'device_1',
    id: 'job_1',
    idempotencyKey: 'idem_1',
    payloadHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    workspaceId: 'workspace_1',
  };
}

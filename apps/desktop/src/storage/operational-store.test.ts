import { describe, expect, it } from 'bun:test';
import {
  type AssetCacheRef,
  type OutboxJobCreateInput,
  createInMemoryOperationalStore,
  evaluateOperationalStoreBackpressure,
  toRendererSafeAssetRef,
} from './index';

const now = '2026-07-06T00:00:00.000Z';

function createJob(overrides: Partial<OutboxJobCreateInput> = {}): OutboxJobCreateInput {
  return {
    assetRefId: 'asset_1',
    createdAt: now,
    deviceId: 'device_1',
    id: 'job_1',
    idempotencyKey: 'idem_1',
    payloadHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    workspaceId: 'workspace_1',
    ...overrides,
  };
}

function createAsset(overrides: Partial<AssetCacheRef> = {}): AssetCacheRef {
  return {
    assetRefId: 'asset_1',
    cleanupState: 'retained',
    createdAt: now,
    hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    localAccessKey: 'content-addressed/local/asset_1',
    mimeType: 'image/png',
    role: 'capture_original',
    sizeBytes: 2048,
    workspaceId: 'workspace_1',
    ...overrides,
  };
}

describe('in-memory operational store', () => {
  it('creates, lists, reads, and updates outbox jobs', async () => {
    const store = createInMemoryOperationalStore();

    const created = await store.createOutboxJob(createJob());
    const updated = await store.updateOutboxJobState('job_1', {
      now: '2026-07-06T00:00:01.000Z',
      state: 'uploading',
      serverCaptureId: 'capture_server_1',
    });

    expect(created.ok).toBe(true);
    expect(updated).toMatchObject({ ok: true });
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      id: 'job_1',
      state: 'uploading',
      attempt: 0,
      serverCaptureId: 'capture_server_1',
    });
    expect(await store.listOutboxJobs({ workspaceId: 'workspace_1' })).toHaveLength(1);
  });

  it('normalizes capture privacy decisions with a required decidedAt timestamp', async () => {
    const store = createInMemoryOperationalStore();

    const defaulted = await store.createOutboxJob(createJob());
    const explicit = await store.createOutboxJob(
      createJob({
        capture: {
          observedAt: '2026-07-06T00:00:05.000Z',
          privacyDecision: {
            action: 'redact_context',
            decidedAt: '2026-07-06T00:00:04.000Z',
            policyVersion: 'policy_explicit',
            reasons: ['domain_rule'],
          },
        },
        id: 'job_2',
        idempotencyKey: 'idem_2',
      }),
    );

    expect(defaulted).toMatchObject({
      ok: true,
      value: {
        capture: {
          observedAt: now,
          privacyDecision: {
            decidedAt: now,
          },
        },
      },
    });
    expect(explicit).toMatchObject({
      ok: true,
      value: {
        capture: {
          observedAt: '2026-07-06T00:00:05.000Z',
          privacyDecision: {
            action: 'redact_context',
            decidedAt: '2026-07-06T00:00:04.000Z',
          },
        },
      },
    });
  });

  it('enforces unique idempotency keys per workspace', async () => {
    const store = createInMemoryOperationalStore();

    const first = await store.createOutboxJob(createJob());
    const duplicate = await store.createOutboxJob(
      createJob({
        id: 'job_2',
        idempotencyKey: 'idem_1',
      }),
    );

    expect(first.ok).toBe(true);
    expect(duplicate).toEqual({
      ok: false,
      error: {
        code: 'idempotency_key_conflict',
        message: 'Outbox idempotency key already exists for this workspace.',
      },
    });
  });

  it('claims the next retryable job by retry time and marks it as uploading', async () => {
    const store = createInMemoryOperationalStore();
    await store.createOutboxJob(
      createJob({
        id: 'job_later',
        idempotencyKey: 'idem_later',
        nextRetryAt: '2026-07-06T00:05:00.000Z',
      }),
    );
    await store.createOutboxJob(
      createJob({
        id: 'job_ready',
        idempotencyKey: 'idem_ready',
        nextRetryAt: '2026-07-06T00:01:00.000Z',
      }),
    );

    const claimed = await store.claimNextRetryableOutboxJob({
      maxAttempts: 5,
      now: '2026-07-06T00:02:00.000Z',
      workspaceId: 'workspace_1',
    });

    expect(claimed).toMatchObject({
      id: 'job_ready',
      state: 'uploading',
      lockedAt: '2026-07-06T00:02:00.000Z',
    });
  });

  it('records retryable safe errors with backoff and terminal failures at max attempts', async () => {
    const store = createInMemoryOperationalStore();
    await store.createOutboxJob(createJob());

    const retryable = await store.recordOutboxSafeError('job_1', {
      code: 'server_unavailable',
      maxAttempts: 3,
      message: 'Server is unavailable.',
      now: '2026-07-06T00:00:05.000Z',
      retryable: true,
      retryAt: '2026-07-06T00:01:05.000Z',
    });
    await store.recordOutboxSafeError('job_1', {
      code: 'server_unavailable',
      maxAttempts: 2,
      message: 'Server is still unavailable.',
      now: '2026-07-06T00:01:06.000Z',
      retryable: true,
      retryAt: '2026-07-06T00:02:06.000Z',
    });
    const failed = await store.getOutboxJob('job_1');

    expect(retryable).toMatchObject({
      ok: true,
      value: {
        attempt: 1,
        nextRetryAt: '2026-07-06T00:01:05.000Z',
        state: 'pending',
        lastSafeError: {
          code: 'server_unavailable',
        },
      },
    });
    expect(failed).toMatchObject({
      attempt: 2,
      state: 'failed',
      terminalReason: 'server_unavailable',
    });
  });

  it('treats cancelled as terminal and never revives it through retry or state update', async () => {
    const store = createInMemoryOperationalStore();
    await store.createOutboxJob(createJob());
    await store.markOutboxJobTerminal('job_1', {
      now: '2026-07-06T00:00:10.000Z',
      reason: 'user_cancelled',
      state: 'cancelled',
    });

    const revive = await store.updateOutboxJobState('job_1', {
      now: '2026-07-06T00:00:11.000Z',
      state: 'pending',
    });
    const retry = await store.recordOutboxSafeError('job_1', {
      code: 'server_unavailable',
      maxAttempts: 3,
      message: 'Should not retry.',
      now: '2026-07-06T00:00:12.000Z',
      retryable: true,
      retryAt: '2026-07-06T00:01:12.000Z',
    });
    const claimed = await store.claimNextRetryableOutboxJob({
      maxAttempts: 3,
      now: '2026-07-06T00:02:00.000Z',
      workspaceId: 'workspace_1',
    });

    expect(revive).toEqual({
      ok: false,
      error: {
        code: 'terminal_state_conflict',
        message: 'Terminal outbox jobs cannot transition to another state.',
      },
    });
    expect(retry).toEqual({
      ok: false,
      error: {
        code: 'terminal_state_conflict',
        message: 'Terminal outbox jobs cannot be retried.',
      },
    });
    expect(claimed).toBeNull();
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      state: 'cancelled',
      terminalReason: 'user_cancelled',
    });
  });

  it('rejects terminal-to-terminal overwrites so late success cannot revive cancellation', async () => {
    const store = createInMemoryOperationalStore();
    await store.createOutboxJob(createJob());
    await store.markOutboxJobTerminal('job_1', {
      now: '2026-07-06T00:00:10.000Z',
      reason: 'user_cancelled',
      state: 'cancelled',
    });

    const lateSuccess = await store.markOutboxJobTerminal('job_1', {
      now: '2026-07-06T00:00:11.000Z',
      reason: 'ocr_succeeded',
      serverCaptureId: 'capture_1',
      serverOcrJobId: 'ocr_job_1',
      state: 'synced',
    });

    expect(lateSuccess).toEqual({
      ok: false,
      error: {
        code: 'terminal_state_conflict',
        message: 'Terminal outbox jobs cannot transition to another terminal state.',
      },
    });
    const stored = await store.getOutboxJob('job_1');
    expect(stored?.serverCaptureId).toBeUndefined();
    expect(stored?.serverOcrJobId).toBeUndefined();
    expect(stored).toMatchObject({
      state: 'cancelled',
      terminalReason: 'user_cancelled',
    });
  });

  it('rejects direct terminal updates even when the target state is unchanged', async () => {
    const store = createInMemoryOperationalStore();
    await store.createOutboxJob(createJob());
    await store.markOutboxJobTerminal('job_1', {
      now: '2026-07-06T00:00:10.000Z',
      reason: 'user_cancelled',
      state: 'cancelled',
    });

    const unchangedTerminal = await store.updateOutboxJobState('job_1', {
      now: '2026-07-06T00:00:11.000Z',
      state: 'cancelled',
    });

    expect(unchangedTerminal).toEqual({
      ok: false,
      error: {
        code: 'terminal_state_conflict',
        message: 'Terminal outbox jobs cannot transition to another state.',
      },
    });
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      state: 'cancelled',
      terminalReason: 'user_cancelled',
      updatedAt: '2026-07-06T00:00:10.000Z',
    });
  });

  it('stores asset refs and returns a renderer-safe projection without local absolute paths', async () => {
    const store = createInMemoryOperationalStore();
    await store.upsertAssetCacheRef(
      createAsset({
        localAccessKey: '/Users/alice/Pictures/recapsy/private.png',
      }),
    );

    const asset = await store.getAssetCacheRef('asset_1');
    expect(asset).not.toBeNull();

    if (!asset) {
      throw new Error('Expected asset ref to exist.');
    }

    const projection = toRendererSafeAssetRef(asset);
    const serialized = JSON.stringify(projection);

    expect(asset).toMatchObject({
      assetRefId: 'asset_1',
      localAccessKey: '/Users/alice/Pictures/recapsy/private.png',
    });
    expect(projection).toEqual({
      assetRefId: 'asset_1',
      cleanupState: 'retained',
      createdAt: now,
      hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      mimeType: 'image/png',
      role: 'capture_original',
      sizeBytes: 2048,
    });
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('localAccessKey');
  });

  it('expires policy cache entries by TTL', async () => {
    const store = createInMemoryOperationalStore();
    await store.setPolicyCache({
      actions: ['block_capture'],
      fetchedAt: '2026-07-06T00:00:00.000Z',
      policyVersion: 'policy_v1',
      ttlSeconds: 60,
      workspaceId: 'workspace_1',
    });

    expect(
      await store.getPolicyCache('workspace_1', {
        now: '2026-07-06T00:00:30.000Z',
      }),
    ).toMatchObject({
      expired: false,
      policyVersion: 'policy_v1',
    });
    expect(
      await store.getPolicyCache('workspace_1', {
        now: '2026-07-06T00:01:01.000Z',
      }),
    ).toMatchObject({
      expired: true,
      policyVersion: 'policy_v1',
    });
  });

  it('sets sync cursors, settings cache, and clears workspace or sign-out scoped cache', async () => {
    const store = createInMemoryOperationalStore();
    await store.createOutboxJob(createJob());
    await store.upsertAssetCacheRef(createAsset());
    await store.setSyncCursor({
      cursor: 'cursor_1',
      kind: 'timeline',
      updatedAt: now,
      workspaceId: 'workspace_1',
    });
    await store.setSettingsCache({
      captureEnabled: true,
      deviceId: 'device_1',
      fetchedAt: now,
      serverCapabilities: {
        ocr: true,
        search: true,
        sync: true,
        timeline: true,
      },
      workspaceId: 'workspace_1',
    });

    await store.clearWorkspaceCache('workspace_1');

    expect(await store.listOutboxJobs({ workspaceId: 'workspace_1' })).toEqual([]);
    expect(await store.getAssetCacheRef('asset_1')).toBeNull();
    expect(await store.getSyncCursor('workspace_1', 'timeline')).toBeNull();
    expect(await store.getSettingsCache('workspace_1')).toBeNull();

    await store.setSettingsCache({
      captureEnabled: true,
      deviceId: 'device_2',
      fetchedAt: now,
      serverCapabilities: {
        ocr: false,
        search: false,
        sync: false,
        timeline: false,
      },
      workspaceId: 'workspace_2',
    });
    await store.clearSignOutCache();

    expect(await store.getSettingsCache('workspace_2')).toBeNull();
  });
});

describe('operational store backpressure', () => {
  it('allows capture below configured limits', () => {
    const decision = evaluateOperationalStoreBackpressure(
      {
        assetBytes: 1024,
        maxAttempt: 1,
        queuedJobs: 2,
      },
      {
        maxAssetBytes: 4096,
        maxQueuedJobs: 5,
        maxRetryAttempts: 3,
      },
    );

    expect(decision).toEqual({
      action: 'allow',
      hardLimit: false,
      reasons: [],
    });
  });

  it('pauses capture at hard queue, asset byte, or retry attempt limits', () => {
    const decision = evaluateOperationalStoreBackpressure(
      {
        assetBytes: 4096,
        maxAttempt: 4,
        queuedJobs: 5,
      },
      {
        maxAssetBytes: 4096,
        maxQueuedJobs: 5,
        maxRetryAttempts: 3,
      },
    );

    expect(decision).toEqual({
      action: 'pause',
      hardLimit: true,
      reasons: ['max_queued_jobs_reached', 'max_asset_bytes_reached', 'max_retry_attempts_reached'],
    });
  });
});

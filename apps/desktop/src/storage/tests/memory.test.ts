import { describe, expect, it } from 'bun:test';
import {
  type AssetCacheRef,
  type OutboxJobCreateInput,
  createMemoryStore,
  evaluateOperationalStoreBackpressure,
  toRendererSafeAssetRef,
} from '../index';

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
    availabilityState: 'available',
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

describe('memory operational store', () => {
  it('keeps device-local capture rules across workspace and sign-out cache cleanup', async () => {
    const store = createMemoryStore();
    const rule = {
      action: 'block_capture' as const,
      createdAt: now,
      enabled: true,
      id: 'local-sensitive-app',
      kind: 'bundle_id' as const,
      pattern: 'com.example.sensitive',
      scope: 'local_user' as const,
      updatedAt: now,
    };

    await store.upsertLocalCapturePolicyRule(rule);
    await store.clearWorkspaceCache('workspace_1');
    await store.clearSignOutCache();

    expect(await store.listLocalCapturePolicyRules()).toEqual([rule]);
  });

  it('creates, lists, reads, and updates outbox jobs', async () => {
    const store = createMemoryStore();

    const created = await store.createOutboxJob(createJob());
    const updated = await store.updateOutboxJobState('job_1', {
      now: '2026-07-06T00:00:01.000Z',
      state: 'syncing',
      serverCaptureId: 'capture_server_1',
    });

    expect(created.ok).toBe(true);
    expect(updated).toMatchObject({ ok: true });
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      id: 'job_1',
      state: 'syncing',
      attempt: 0,
      serverCaptureId: 'capture_server_1',
    });
    expect(await store.listOutboxJobs({ workspaceId: 'workspace_1' })).toHaveLength(1);
  });

  it('normalizes capture privacy decisions with a required decidedAt timestamp', async () => {
    const store = createMemoryStore();

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
    const store = createMemoryStore();

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

  it('creates capture outbox entries atomically and rolls back asset refs on capacity failure', async () => {
    const store = createMemoryStore({ maxActiveOutboxJobs: 0 });

    const result = await store.createCaptureOutboxEntry({
      ...createJob(),
      assetRefs: [createAsset()],
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'capacity_exceeded',
        message: 'Outbox active job capacity has been reached.',
      },
    });
    expect(await store.getAssetCacheRef('asset_1')).toBeNull();
    expect(await store.getOutboxJob('job_1')).toBeNull();
  });

  it('treats identical capture outbox idempotency conflicts as success and divergent ones as conflicts', async () => {
    const store = createMemoryStore();
    const entry = {
      ...createJob(),
      assetRefs: [createAsset()],
    };

    const first = await store.createCaptureOutboxEntry(entry);
    const identical = await store.createCaptureOutboxEntry(entry);
    const divergent = await store.createCaptureOutboxEntry({
      ...entry,
      assetRefs: [
        createAsset({
          hash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        }),
      ],
      payloadHash: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    });

    expect(first.ok).toBe(true);
    expect(identical).toMatchObject({
      ok: true,
      value: {
        id: 'job_1',
        state: 'pending',
      },
    });
    expect(divergent).toEqual({
      ok: false,
      error: {
        code: 'idempotency_key_conflict',
        message: 'Outbox idempotency key already exists for this workspace.',
      },
    });
    expect(await store.getAssetCacheRef('asset_1')).toMatchObject({
      hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
  });

  it('claims the next retryable job by retry time and marks it as syncing', async () => {
    const store = createMemoryStore();
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
      state: 'syncing',
      lockedAt: '2026-07-06T00:02:00.000Z',
    });
  });

  it('rejects a stale worker write after recovery grants the job a new lease', async () => {
    const store = createMemoryStore();
    await store.createOutboxJob(createJob({ id: 'job_lease', idempotencyKey: 'idem_lease' }));

    const first = await store.claimNextRetryableOutboxJob({
      maxAttempts: 3,
      now: '2026-07-06T00:00:00.000Z',
      workspaceId: 'workspace_1',
    });
    expect(first?.leaseToken).toBeDefined();
    await store.recoverInterruptedOutboxJob({
      id: 'job_lease',
      lastSafeError: {
        code: 'interrupted_during_sync',
        message: 'Outbox sync was interrupted before startup recovery.',
        retryable: true,
      },
      leaseToken: first?.leaseToken,
      nextRetryAt: '2026-07-06T00:00:01.000Z',
      now: '2026-07-06T00:00:01.000Z',
    });
    const second = await store.claimNextRetryableOutboxJob({
      maxAttempts: 3,
      now: '2026-07-06T00:00:01.000Z',
      workspaceId: 'workspace_1',
    });

    const stale = await store.markOutboxJobTerminal('job_lease', {
      leaseToken: first?.leaseToken,
      now: '2026-07-06T00:00:02.000Z',
      reason: 'ocr_synced',
      state: 'synced',
    });
    const current = await store.markOutboxJobTerminal('job_lease', {
      leaseToken: second?.leaseToken,
      now: '2026-07-06T00:00:03.000Z',
      reason: 'ocr_synced',
      state: 'synced',
    });

    expect(stale).toEqual({
      error: {
        code: 'outbox_lease_lost',
        message: 'Outbox job lease is no longer held by this worker.',
      },
      ok: false,
    });
    expect(current).toMatchObject({ ok: true, value: { state: 'synced' } });
  });

  it('records retryable safe errors with backoff and terminal failures at max attempts', async () => {
    const store = createMemoryStore();
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
    const store = createMemoryStore();
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
    const store = createMemoryStore();
    await store.createOutboxJob(createJob());
    await store.markOutboxJobTerminal('job_1', {
      now: '2026-07-06T00:00:10.000Z',
      reason: 'user_cancelled',
      state: 'cancelled',
    });

    const lateSuccess = await store.markOutboxJobTerminal('job_1', {
      now: '2026-07-06T00:00:11.000Z',
      reason: 'ocr_synced',
      serverCaptureId: 'capture_1',
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
    expect(stored).toMatchObject({
      state: 'cancelled',
      terminalReason: 'user_cancelled',
    });
  });

  it('rejects direct terminal updates even when the target state is unchanged', async () => {
    const store = createMemoryStore();
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
    const store = createMemoryStore();
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
      availabilityCheckedAt: undefined,
      availabilitySafeError: undefined,
      availabilityState: 'available',
      cleanupState: 'retained',
      createdAt: now,
      mimeType: 'image/png',
      role: 'capture_original',
      sizeBytes: 2048,
    });
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('localAccessKey');
  });

  it('expires policy cache entries by TTL', async () => {
    const store = createMemoryStore();
    await store.setPolicyCache({
      deviceId: 'device_1',
      fetchedAt: '2026-07-06T00:00:00.000Z',
      policy: {
        axTextUploadEnabled: false,
        defaultAction: 'allow',
        paused: false,
        rules: [],
      },
      policySnapshotId: 'snapshot_1',
      policyVersion: 'policy_primary',
      ttlSeconds: 60,
      workspaceId: 'workspace_1',
    });

    expect(
      await store.getPolicyCache('workspace_1', 'device_1', {
        now: '2026-07-06T00:00:30.000Z',
      }),
    ).toMatchObject({
      expired: false,
      policyVersion: 'policy_primary',
    });
    expect(
      await store.getPolicyCache('workspace_1', 'device_1', {
        now: '2026-07-06T00:01:01.000Z',
      }),
    ).toMatchObject({
      expired: true,
      policyVersion: 'policy_primary',
    });
  });

  it('sets sync cursors, settings cache, and clears workspace or sign-out scoped cache', async () => {
    const store = createMemoryStore();
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
        queuedJobs: 2,
        retryingJobs: 1,
      },
      {
        maxAssetBytes: 4096,
        maxQueuedJobs: 5,
        maxRetryingJobs: 3,
        resumeAssetBytes: 2048,
        resumeQueuedJobs: 2,
        resumeRetryingJobs: 1,
      },
    );

    expect(decision).toEqual({
      action: 'allow',
      hardLimit: false,
      reasons: [],
    });
  });

  it('pauses capture at hard queue or asset byte limits', () => {
    const decision = evaluateOperationalStoreBackpressure(
      {
        assetBytes: 4096,
        queuedJobs: 5,
        retryingJobs: 3,
      },
      {
        maxAssetBytes: 4096,
        maxQueuedJobs: 5,
        maxRetryingJobs: 3,
        resumeAssetBytes: 2048,
        resumeQueuedJobs: 2,
        resumeRetryingJobs: 1,
      },
    );

    expect(decision).toEqual({
      action: 'pause',
      hardLimit: true,
      reasons: ['max_queued_jobs_reached', 'max_retrying_jobs_reached', 'max_asset_bytes_reached'],
    });
  });
});

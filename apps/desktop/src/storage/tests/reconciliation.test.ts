import { describe, expect, it } from 'bun:test';
import {
  type AssetAvailabilityState,
  type AssetCacheRef,
  type OutboxJobCreateInput,
  type StoredOcrResult,
  createMemoryStore,
} from '../index';
import {
  type AssetAvailabilityResolver,
  createHistoricalAssetReconciliation,
  reconcileActiveAssetRefs,
} from '../reconciliation';

const now = '2026-07-06T00:00:00.000Z';
const reconcileNow = '2026-07-06T00:05:00.000Z';

describe('active asset ref reconciliation', () => {
  it('leaves available refs and associated retryable jobs unchanged in memory', async () => {
    const store = createMemoryStore();
    await createAssetBackedJob(store, createAsset(), createJob());

    const summary = await reconcileActiveAssetRefs({
      now: reconcileNow,
      resolver: resolverReturning('available'),
      store,
      workspaceId: 'workspace_1',
    });

    expect(summary).toEqual({
      available: 1,
      blocked: 0,
      checked: 1,
      missing: 0,
      unreadable: 0,
    });
    expect(await store.getAssetCacheRef('asset_1')).toMatchObject({
      availabilityCheckedAt: reconcileNow,
      availabilityState: 'available',
    });
    const job = await store.getOutboxJob('job_1');
    expect(job).toMatchObject({
      state: 'pending',
    });
    expect(job?.terminalReason).toBeUndefined();
  });

  it('records missing and unreadable refs and blocks eligible pending and syncing jobs', async () => {
    const store = createMemoryStore();
    await createAssetBackedJob(
      store,
      createAsset({ assetRefId: 'asset_missing' }),
      createJob({ assetRefId: 'asset_missing', id: 'job_missing', idempotencyKey: 'idem_missing' }),
    );
    await createAssetBackedJob(
      store,
      createAsset({ assetRefId: 'asset_unreadable' }),
      createJob({
        assetRefId: 'asset_unreadable',
        id: 'job_unreadable',
        idempotencyKey: 'idem_unreadable',
      }),
    );
    await store.updateOutboxJobState('job_unreadable', {
      now,
      state: 'syncing',
    });

    const summary = await reconcileActiveAssetRefs({
      now: reconcileNow,
      resolver: resolverFromMap({
        asset_missing: 'missing',
        asset_unreadable: 'unreadable',
      }),
      store,
      workspaceId: 'workspace_1',
    });

    expect(summary).toMatchObject({
      blocked: 2,
      checked: 2,
      missing: 1,
      unreadable: 1,
    });
    expect(await store.getAssetCacheRef('asset_missing')).toMatchObject({
      availabilityCheckedAt: reconcileNow,
      availabilitySafeError: {
        code: 'local_asset_missing',
        message: 'Local asset is missing.',
        retryable: false,
      },
      availabilityState: 'missing',
    });
    expect(await store.getAssetCacheRef('asset_unreadable')).toMatchObject({
      availabilitySafeError: {
        code: 'local_asset_unreadable',
      },
      availabilityState: 'unreadable',
    });
    expect(await store.getOutboxJob('job_missing')).toMatchObject({
      lastSafeError: {
        code: 'local_asset_missing',
        message: 'Local asset is missing.',
        retryable: false,
      },
      state: 'blocked',
      terminalReason: 'local_asset_missing',
      updatedAt: reconcileNow,
    });
    expect(await store.getOutboxJob('job_unreadable')).toMatchObject({
      lockedAt: undefined,
      state: 'blocked',
      terminalReason: 'local_asset_unreadable',
    });
  });

  it('leaves result_pending jobs untouched when local assets are gone', async () => {
    const store = createMemoryStore();
    await createAssetBackedJob(store, createAsset(), createJob());
    await createAssetBackedJob(
      store,
      createAsset({ assetRefId: 'asset_result_pending' }),
      createJob({
        assetRefId: 'asset_result_pending',
        id: 'job_result_pending',
        idempotencyKey: 'idem_result_pending',
      }),
    );
    await store.markOutboxJobTerminal('job_1', {
      now,
      reason: 'already_synced',
      state: 'synced',
    });
    await store.updateOutboxJobState('job_result_pending', {
      now,
      ocrResult: createStoredOcrResult(),
      serverCaptureId: 'capture_result_pending',
      state: 'result_pending',
    });

    const summary = await reconcileActiveAssetRefs({
      now: reconcileNow,
      resolver: resolverReturning('missing'),
      store,
      workspaceId: 'workspace_1',
    });

    expect(summary).toEqual({
      available: 0,
      blocked: 0,
      checked: 0,
      missing: 0,
      unreadable: 0,
    });
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      state: 'synced',
      terminalReason: 'already_synced',
    });
    // A result_pending job already holds its transcript locally and no longer
    // needs the original bytes, so a missing asset must not block it.
    const resultPendingJob = await store.getOutboxJob('job_result_pending');
    expect(resultPendingJob).toMatchObject({
      serverCaptureId: 'capture_result_pending',
      state: 'result_pending',
    });
    expect(resultPendingJob?.terminalReason).toBeUndefined();
  });

  it('leaves recovered OCR submissions pending when their original asset is missing', async () => {
    const store = createMemoryStore();
    await createAssetBackedJob(store, createAsset(), createJob());
    await store.updateOutboxJobState('job_1', {
      now,
      ocrResult: createStoredOcrResult(),
      serverCaptureId: 'capture_result_pending',
      state: 'result_pending',
    });
    await store.recoverInterruptedOutboxJob({
      id: 'job_1',
      lastSafeError: {
        code: 'interrupted_before_result_submit',
        message: 'OCR result submission was interrupted before startup recovery.',
        retryable: true,
      },
      nextRetryAt: reconcileNow,
      now: reconcileNow,
    });

    const summary = await reconcileActiveAssetRefs({
      now: reconcileNow,
      resolver: resolverReturning('missing'),
      store,
      workspaceId: 'workspace_1',
    });

    expect(summary).toEqual({
      available: 0,
      blocked: 0,
      checked: 0,
      missing: 0,
      unreadable: 0,
    });
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      ocrResult: {
        sourceAssetHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      },
      serverCaptureId: 'capture_result_pending',
      state: 'pending',
    });
  });

  it('checks only assets still needed by active outbox jobs', async () => {
    const store = createMemoryStore();
    const checked: string[] = [];
    await createAssetBackedJob(
      store,
      createAsset({
        assetRefId: 'asset_terminal',
        availabilityCheckedAt: '2026-07-06T00:04:00.000Z',
      }),
      createJob({
        assetRefId: 'asset_terminal',
        id: 'job_terminal',
        idempotencyKey: 'idem_terminal',
      }),
    );
    await store.markOutboxJobTerminal('job_terminal', {
      now,
      reason: 'completed',
      state: 'synced',
    });
    await createAssetBackedJob(
      store,
      createAsset({
        assetRefId: 'asset_active',
        availabilityCheckedAt: '2026-07-06T00:04:00.000Z',
      }),
      createJob({
        assetRefId: 'asset_active',
        id: 'job_active',
        idempotencyKey: 'idem_active',
      }),
    );

    await createAssetBackedJob(
      store,
      createAsset({ assetRefId: 'asset_privacy_blocked' }),
      createJob({
        assetRefId: 'asset_privacy_blocked',
        capture: { privacyDecision: { action: 'block_ocr' } },
        id: 'job_privacy_blocked',
        idempotencyKey: 'idem_privacy_blocked',
      }),
    );

    const summary = await reconcileActiveAssetRefs({
      now: reconcileNow,
      resolver: {
        async checkAvailability(asset) {
          checked.push(asset.assetRefId);
          return { availabilityState: 'available' };
        },
      },
      store,
      workspaceId: 'workspace_1',
    });

    expect(summary).toEqual({
      available: 1,
      blocked: 0,
      checked: 1,
      missing: 0,
      unreadable: 0,
    });
    expect(checked).toEqual(['asset_active']);
    expect((await store.getAssetCacheRef('asset_terminal'))?.availabilityCheckedAt).toBe(
      '2026-07-06T00:04:00.000Z',
    );
  });

  it('can reconcile all workspaces without returning sensitive asset fields in the summary', async () => {
    const store = createMemoryStore();
    await createAssetBackedJob(store, createAsset(), createJob());
    await createAssetBackedJob(
      store,
      createAsset({
        assetRefId: 'asset_workspace_2',
        localAccessKey: '/Users/alice/private/capture.png',
        workspaceId: 'workspace_2',
      }),
      createJob({
        assetRefId: 'asset_workspace_2',
        id: 'job_workspace_2',
        idempotencyKey: 'idem_workspace_2',
        workspaceId: 'workspace_2',
      }),
    );

    const summary = await reconcileActiveAssetRefs({
      now: reconcileNow,
      resolver: resolverReturning('missing'),
      store,
    });
    const serialized = JSON.stringify(summary);

    expect(summary).toMatchObject({
      blocked: 2,
      checked: 2,
      missing: 2,
    });
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('localAccessKey');
    expect(serialized).not.toContain('contentAddress');
  });

  it('maps resolver exceptions to a fixed unreadable state without storing raw exception text', async () => {
    const store = createMemoryStore();
    await createAssetBackedJob(store, createAsset(), createJob());

    const summary = await reconcileActiveAssetRefs({
      now: reconcileNow,
      resolver: {
        async checkAvailability(): Promise<never> {
          throw new Error('/Users/alice/private.png permission denied with token secret');
        },
      },
      store,
      workspaceId: 'workspace_1',
    });
    const storedAsset = await store.getAssetCacheRef('asset_1');
    const storedJob = await store.getOutboxJob('job_1');
    const serialized = JSON.stringify({ storedAsset, storedJob, summary });

    expect(summary).toMatchObject({
      blocked: 1,
      checked: 1,
      unreadable: 1,
    });
    expect(storedAsset).toMatchObject({
      availabilitySafeError: {
        code: 'local_asset_unreadable',
        message: 'Local asset is unreadable.',
      },
      availabilityState: 'unreadable',
    });
    expect(storedJob).toMatchObject({
      lastSafeError: {
        code: 'local_asset_unreadable',
        message: 'Local asset is unreadable.',
      },
      state: 'blocked',
    });
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('permission denied');
    expect(serialized).not.toContain('secret');
  });
});

describe('historical asset reconciliation', () => {
  it('sweeps terminal assets in bounded pages without delaying active reconciliation', async () => {
    const store = createMemoryStore();
    const checked: string[] = [];

    for (const assetRefId of ['asset_1', 'asset_2', 'asset_3']) {
      await store.upsertAssetCacheRef(createAsset({ assetRefId }));
    }

    const reconciliation = createHistoricalAssetReconciliation({
      now: () => reconcileNow,
      pageSize: 2,
      resolver: {
        async checkAvailability(asset) {
          checked.push(asset.assetRefId);
          return { availabilityState: 'available' };
        },
      },
      store,
      workspaceId: 'workspace_1',
    });

    reconciliation.start();
    await waitFor(() => checked.length === 3);
    await waitFor(
      async () => (await store.getAssetCacheRef('asset_3'))?.availabilityCheckedAt === reconcileNow,
    );
    await reconciliation.stop();

    expect(checked).toEqual(['asset_1', 'asset_2', 'asset_3']);
    expect((await store.getAssetCacheRef('asset_1'))?.availabilityCheckedAt).toBe(reconcileNow);
    expect((await store.getAssetCacheRef('asset_2'))?.availabilityCheckedAt).toBe(reconcileNow);
    expect((await store.getAssetCacheRef('asset_3'))?.availabilityCheckedAt).toBe(reconcileNow);
  });

  it('keeps one sweep in flight and prevents an interrupted generation from writing after stop', async () => {
    const store = createMemoryStore();
    await store.upsertAssetCacheRef(createAsset());
    const firstCheck = Promise.withResolvers<void>();
    let checks = 0;

    const reconciliation = createHistoricalAssetReconciliation({
      now: () => reconcileNow,
      resolver: {
        async checkAvailability() {
          checks += 1;
          if (checks === 1) await firstCheck.promise;
          return { availabilityState: 'available' };
        },
      },
      store,
      workspaceId: 'workspace_1',
    });

    reconciliation.start();
    reconciliation.start();
    await waitFor(() => checks === 1);

    const stopping = reconciliation.stop();
    reconciliation.start();
    firstCheck.resolve();
    await stopping;
    await waitFor(() => checks === 2);
    await reconciliation.stop();

    expect(checks).toBe(2);
    expect((await store.getAssetCacheRef('asset_1'))?.availabilityCheckedAt).toBe(reconcileNow);
  });
});

describe('server capture settlement', () => {
  it('settles an owned job and preserves idempotent success for the same server capture', async () => {
    const store = createMemoryStore();
    await createAssetBackedJob(store, createAsset(), createJob());

    expect(
      await store.settleServerCapture({
        id: 'job_1',
        now: reconcileNow,
        serverCaptureId: 'server-capture-1',
      }),
    ).toEqual({ status: 'synced' });
    expect(
      await store.settleServerCapture({
        id: 'job_1',
        now: reconcileNow,
        serverCaptureId: 'server-capture-1',
      }),
    ).toEqual({ status: 'synced' });
  });

  it('reports lease loss without accepting another owner or a different server capture', async () => {
    const store = createMemoryStore();
    await createAssetBackedJob(store, createAsset(), createJob());
    const claimed = await store.claimNextRetryableOutboxJob({
      maxAttempts: 3,
      now,
      workspaceId: 'workspace_1',
    });
    if (!claimed?.leaseToken) {
      throw new Error('Expected a leased outbox job.');
    }

    expect(
      await store.settleServerCapture({
        id: 'job_1',
        leaseToken: 'stale-owner',
        now: reconcileNow,
        serverCaptureId: 'server-capture-1',
      }),
    ).toEqual({ code: 'lease_lost', status: 'skipped' });

    expect(
      await store.settleServerCapture({
        id: 'job_1',
        leaseToken: claimed.leaseToken,
        now: reconcileNow,
        serverCaptureId: 'server-capture-1',
      }),
    ).toEqual({ status: 'synced' });
    expect(
      await store.settleServerCapture({
        id: 'job_1',
        now: reconcileNow,
        serverCaptureId: 'different-server-capture',
      }),
    ).toEqual({ status: 'skipped' });
  });
});

function resolverReturning(availabilityState: AssetAvailabilityState): AssetAvailabilityResolver {
  return {
    async checkAvailability() {
      return { availabilityState };
    },
  };
}

function resolverFromMap(map: Record<string, AssetAvailabilityState>): AssetAvailabilityResolver {
  return {
    async checkAvailability(asset) {
      return { availabilityState: map[asset.assetRefId] ?? 'available' };
    },
  };
}

async function createAssetBackedJob(
  store: ReturnType<typeof createMemoryStore>,
  asset: AssetCacheRef,
  job: OutboxJobCreateInput,
): Promise<void> {
  await store.upsertAssetCacheRef(asset);
  const result = await store.createOutboxJob(job);
  if (!result.ok) {
    throw new Error(result.error.code);
  }
}

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

function createStoredOcrResult(overrides: Partial<StoredOcrResult> = {}): StoredOcrResult {
  return {
    durationMs: 1200,
    qualityFlags: [],
    model: 'test-model',
    providerName: 'test-provider',
    screenText: {
      blocks: [{ kind: 'text', readingOrder: 0, source: 'image_ocr', text: 'hello' }],
      readingOrder: 'top_to_bottom_left_to_right',
      source: 'image_ocr',
    },
    sourceAssetHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
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

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (await predicate()) return;
    await Promise.resolve();
  }

  throw new Error('Timed out waiting for asynchronous reconciliation.');
}

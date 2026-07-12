import { describe, expect, it } from 'bun:test';
import {
  type AssetAvailabilityState,
  type AssetCacheRef,
  type OperationalStoreRepository,
  type OutboxJobCreateInput,
  type StoredOcrResult,
  createInMemoryOperationalStore,
} from '../storage';
import {
  type AssetAvailabilityResolver,
  reconcileAssetRefs,
} from '../storage/asset-reconciliation';

const now = '2026-07-06T00:00:00.000Z';
const reconcileNow = '2026-07-06T00:05:00.000Z';

describe('asset ref reconciliation', () => {
  it('leaves available refs and associated retryable jobs unchanged in memory', async () => {
    const store = createInMemoryOperationalStore();
    await createAssetBackedJob(store, createAsset(), createJob());

    const summary = await reconcileAssetRefs({
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
      skippedTerminal: 0,
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
    const store = createInMemoryOperationalStore();
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

    const summary = await reconcileAssetRefs({
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

  it('does not revive terminal jobs and leaves result_pending jobs untouched when local assets are gone', async () => {
    const store = createInMemoryOperationalStore();
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

    const summary = await reconcileAssetRefs({
      now: reconcileNow,
      resolver: resolverReturning('missing'),
      store,
      workspaceId: 'workspace_1',
    });

    expect(summary).toMatchObject({
      blocked: 0,
      checked: 2,
      missing: 2,
      skippedTerminal: 1,
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

  it('can reconcile all workspaces without returning sensitive asset fields in the summary', async () => {
    const store = createInMemoryOperationalStore();
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

    const summary = await reconcileAssetRefs({
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
    const store = createInMemoryOperationalStore();
    await createAssetBackedJob(store, createAsset(), createJob());

    const summary = await reconcileAssetRefs({
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
  store: OperationalStoreRepository,
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

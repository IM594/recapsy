import { describe, expect, it } from 'bun:test';
import {
  type AssetAvailabilityState,
  type AssetCacheRef,
  type OperationalStoreRepository,
  type OutboxJobCreateInput,
  createInMemoryOperationalStore,
} from '../storage';
import {
  type AssetAvailabilityResolver,
  reconcileAssetRefs,
} from '../storage/asset-reconciliation';
import { createSyncScheduler } from './scheduler';
import { recoverInterruptedOutboxJobs } from './startup-recovery';
import type { SyncServerApi } from './types';

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
      skippedServerPolling: 0,
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

  it('records missing and unreadable refs and blocks eligible outbox jobs', async () => {
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
    await createAssetBackedJob(
      store,
      createAsset({ assetRefId: 'asset_ocr_wait_without_server_job' }),
      createJob({
        assetRefId: 'asset_ocr_wait_without_server_job',
        id: 'job_ocr_wait_without_server_job',
        idempotencyKey: 'idem_ocr_wait_without_server_job',
      }),
    );
    await store.updateOutboxJobState('job_unreadable', {
      now,
      state: 'uploading',
    });
    await store.updateOutboxJobState('job_ocr_wait_without_server_job', {
      now,
      state: 'ocr_wait',
    });

    const summary = await reconcileAssetRefs({
      now: reconcileNow,
      resolver: resolverFromMap({
        asset_missing: 'missing',
        asset_ocr_wait_without_server_job: 'missing',
        asset_unreadable: 'unreadable',
      }),
      store,
      workspaceId: 'workspace_1',
    });

    expect(summary).toMatchObject({
      blocked: 3,
      checked: 3,
      missing: 2,
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
    expect(await store.getOutboxJob('job_ocr_wait_without_server_job')).toMatchObject({
      state: 'blocked',
      terminalReason: 'local_asset_missing',
    });
  });

  it('does not revive terminal jobs or block OCR polling jobs that already have a server job id', async () => {
    const store = createInMemoryOperationalStore();
    await createAssetBackedJob(store, createAsset(), createJob());
    await createAssetBackedJob(
      store,
      createAsset({ assetRefId: 'asset_poll' }),
      createJob({ assetRefId: 'asset_poll', id: 'job_poll', idempotencyKey: 'idem_poll' }),
    );
    await store.markOutboxJobTerminal('job_1', {
      now,
      reason: 'already_synced',
      state: 'synced',
    });
    await store.updateOutboxJobState('job_poll', {
      now,
      serverOcrJobId: 'server_ocr_1',
      state: 'ocr_wait',
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
      skippedServerPolling: 1,
      skippedTerminal: 1,
    });
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      state: 'synced',
      terminalReason: 'already_synced',
    });
    const pollingJob = await store.getOutboxJob('job_poll');
    expect(pollingJob).toMatchObject({
      serverOcrJobId: 'server_ocr_1',
      state: 'ocr_wait',
    });
    expect(pollingJob?.terminalReason).toBeUndefined();
  });

  it('keeps recovered server OCR polling jobs retryable when local assets are unavailable', async () => {
    const store = createInMemoryOperationalStore();
    await createAssetBackedJob(
      store,
      createAsset({ assetRefId: 'asset_recovered_missing' }),
      createJob({
        assetRefId: 'asset_recovered_missing',
        id: 'job_recovered_missing',
        idempotencyKey: 'idem_recovered_missing',
      }),
    );
    await createAssetBackedJob(
      store,
      createAsset({ assetRefId: 'asset_recovered_unreadable' }),
      createJob({
        assetRefId: 'asset_recovered_unreadable',
        id: 'job_recovered_unreadable',
        idempotencyKey: 'idem_recovered_unreadable',
      }),
    );
    await store.updateOutboxJobState('job_recovered_missing', {
      now,
      serverCaptureId: 'capture_recovered_missing',
      serverOcrJobId: 'server_ocr_missing',
      state: 'ocr_wait',
    });
    await store.updateOutboxJobState('job_recovered_unreadable', {
      now,
      serverCaptureId: 'capture_recovered_unreadable',
      serverOcrJobId: 'server_ocr_unreadable',
      state: 'ocr_wait',
    });

    const recoverySummary = await recoverInterruptedOutboxJobs({
      now,
      store,
      workspaceId: 'workspace_1',
    });

    expect(recoverySummary).toMatchObject({
      ocrPolling: 2,
      recovered: 2,
    });
    expect(await store.getOutboxJob('job_recovered_missing')).toMatchObject({
      serverOcrJobId: 'server_ocr_missing',
      state: 'pending',
    });
    expect(await store.getOutboxJob('job_recovered_unreadable')).toMatchObject({
      serverOcrJobId: 'server_ocr_unreadable',
      state: 'pending',
    });

    const reconciliationSummary = await reconcileAssetRefs({
      now: reconcileNow,
      resolver: resolverFromMap({
        asset_recovered_missing: 'missing',
        asset_recovered_unreadable: 'unreadable',
      }),
      store,
      workspaceId: 'workspace_1',
    });

    expect(reconciliationSummary).toMatchObject({
      blocked: 0,
      checked: 2,
      missing: 1,
      skippedServerPolling: 2,
      unreadable: 1,
    });
    expect(await store.getOutboxJob('job_recovered_missing')).toMatchObject({
      serverOcrJobId: 'server_ocr_missing',
      state: 'pending',
    });
    expect(await store.getOutboxJob('job_recovered_unreadable')).toMatchObject({
      serverOcrJobId: 'server_ocr_unreadable',
      state: 'pending',
    });

    const calls: string[] = [];
    const scheduler = createPollingScheduler({
      api: createApi({
        async pollOcrJob(workspaceId, jobId) {
          calls.push(`poll:${workspaceId}:${jobId}`);
          return {
            job: {
              id: jobId,
              status: 'succeeded',
            },
          };
        },
      }),
      readAssetBytes: async () => {
        calls.push('read-bytes');
        throw new Error('readAssetBytes must not run for recovered OCR polling jobs');
      },
      store,
    });

    expect(await scheduler.runOnce()).toMatchObject({
      processed: 1,
      status: 'synced',
    });
    expect(await scheduler.runOnce()).toMatchObject({
      processed: 1,
      status: 'synced',
    });
    expect(calls.sort()).toEqual([
      'poll:workspace_1:server_ocr_missing',
      'poll:workspace_1:server_ocr_unreadable',
    ]);
    expect(await store.getOutboxJob('job_recovered_missing')).toMatchObject({
      serverOcrJobId: 'server_ocr_missing',
      state: 'synced',
      terminalReason: 'ocr_succeeded',
    });
    expect(await store.getOutboxJob('job_recovered_unreadable')).toMatchObject({
      serverOcrJobId: 'server_ocr_unreadable',
      state: 'synced',
      terminalReason: 'ocr_succeeded',
    });
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
    expect(serialized).not.toContain('ocr');
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

function createPollingScheduler(input: {
  api: SyncServerApi;
  readAssetBytes?: (localAccessKey: string) => Promise<Uint8Array>;
  store: OperationalStoreRepository;
}) {
  return createSyncScheduler({
    api: input.api,
    clock: createClock(),
    maxAttempts: 3,
    readAssetBytes: input.readAssetBytes ?? (async () => new Uint8Array([1, 2, 3, 4])),
    retryDelayMs: 60_000,
    store: input.store,
    workspace: {
      getActiveWorkspaceId: async () => 'workspace_1',
    },
  });
}

function createApi(overrides: Partial<SyncServerApi> = {}): SyncServerApi {
  return {
    async cancelOcrJob(jobId) {
      return {
        cleanupStatus: 'pending',
        job: {
          id: jobId,
          status: 'cancelled',
        },
      };
    },
    async createOcrJob() {
      throw new Error('createOcrJob must not run for recovered OCR polling jobs');
    },
    async createTemporaryUpload() {
      throw new Error('createTemporaryUpload must not run for recovered OCR polling jobs');
    },
    async getAxAllowlist() {
      return {
        axTextUploadEnabled: false,
        enabled: false,
        reason: 'ax_text_upload_disabled',
        status: 'disabled',
        workspaceId: 'workspace_1',
      };
    },
    async getCapabilities() {
      return {
        features: {},
        generatedAt: now,
        providers: [],
        workspaceId: 'workspace_1',
      };
    },
    async getCapturePolicies() {
      return {
        axAllowlist: {
          axTextUploadEnabled: false,
          enabled: false,
          reason: 'ax_text_upload_disabled',
          status: 'disabled',
          workspaceId: 'workspace_1',
        },
        capturePolicy: {
          actionCounts: {},
          axTextUploadEnabled: false,
          defaultAction: 'allow',
          expiresAt: now,
          paused: false,
          ttlSeconds: 1800,
          version: 'policy_1',
        },
        generatedAt: now,
        storagePolicy: {
          allowLongTermRemoteOriginal: false,
          allowTemporaryServerRead: true,
          authoritativeOriginalLocation: 'local_device',
          temporaryTtlSeconds: 1800,
        },
        workspaceId: 'workspace_1',
      };
    },
    async ingestCapture() {
      throw new Error('ingestCapture must not run for recovered OCR polling jobs');
    },
    async pollOcrJob(_workspaceId, jobId) {
      return {
        job: {
          id: jobId,
          status: 'succeeded',
        },
      };
    },
    async putTemporaryBytes() {
      throw new Error('putTemporaryBytes must not run for recovered OCR polling jobs');
    },
    async querySearch() {
      return {
        incomplete: false,
        items: [],
      };
    },
    async queryTimeline() {
      return {
        incomplete: false,
        items: [],
      };
    },
    ...overrides,
  };
}

function createClock() {
  let tick = 0;
  return {
    now: () => `2026-07-06T00:00:0${tick++}.000Z`,
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

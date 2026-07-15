import { describe, expect, it } from 'bun:test';
import { ServerApiError } from '../../server/index';
import { createMemoryStore } from '../../storage';
import type { AssetCacheRef, OutboxJobCreateInput, StoredOcrResult } from '../../storage';
import { createSyncJobExecutor } from '../job';
import { createSyncQueueSummary } from '../summary';
import type { SyncServerApi } from '../types';

const now = '2026-07-06T00:00:00.000Z';

describe('desktop sync job executor', () => {
  it('guards against workspace switches during a sync run', async () => {
    const store = createMemoryStore();
    await seedPendingCapture(store);
    let activeWorkspace: string | null = 'workspace_1';
    const worker = createJobRunner({
      api: createApi({
        async createCapture() {
          activeWorkspace = 'workspace_2';
          return {
            captureId: 'capture_1',
            inputAssetId: 'asset_server_1',
            nextAction: 'queue_ocr',
            timelineEventId: 'timeline_1',
          };
        },
      }),
      getWorkspaceId: async () => activeWorkspace,
      store,
    });

    const result = await worker.runOnce();
    const job = await store.getOutboxJob('job_1');

    expect(result).toMatchObject({
      processed: 1,
      status: 'retry_wait',
    });
    expect(job).toMatchObject({
      lastSafeError: {
        code: 'workspace_required',
        retryable: true,
      },
      state: 'pending',
    });
  });

  it('runs capture creation, the OCR proxy, and result submission to reach synced', async () => {
    const store = createMemoryStore();
    await seedPendingCapture(store);
    const calls: string[] = [];
    const worker = createJobRunner({
      api: createApi({
        async createCapture(input) {
          calls.push(`create:${input.idempotencyKey}`);
          return {
            captureId: 'capture_1',
            inputAssetId: 'asset_server_1',
            nextAction: 'queue_ocr',
            timelineEventId: 'timeline_1',
          };
        },
        async runOcrProxy(input) {
          calls.push(`proxy:${input.bytes.byteLength}:${input.mimeType}`);
          return createOcrResponse();
        },
        async submitOcrResult(input) {
          calls.push(`submit:${input.captureId}:${input.sourceAssetHash}`);
          return createSubmitResponse();
        },
      }),
      store,
    });

    const result = await worker.runOnce();

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      status: 'synced',
    });
    expect(calls).toEqual(['create:idem_1', 'proxy:4:image/png', `submit:capture_1:${assetHash}`]);
    const job = await store.getOutboxJob('job_1');
    expect(job).toMatchObject({
      serverCaptureId: 'capture_1',
      state: 'synced',
      terminalReason: 'ocr_synced',
    });
  });

  it('resubmits a crash-recovered result_pending job without re-running the proxy', async () => {
    const store = createMemoryStore();
    await seedPendingCapture(store);
    // Simulate a job that reached result_pending, was recovered to pending by
    // startup recovery, and still carries its locally stored transcript.
    await store.updateOutboxJobState('job_1', {
      now: '2026-07-06T00:00:01.000Z',
      ocrResult: createStoredOcrResult(),
      serverCaptureId: 'capture_existing',
      state: 'result_pending',
    });
    await store.recoverInterruptedOutboxJob({
      id: 'job_1',
      lastSafeError: {
        code: 'interrupted_before_result_submit',
        message: 'OCR result submission was interrupted before startup recovery.',
        retryable: true,
      },
      nextRetryAt: now,
      now,
    });
    const calls: string[] = [];
    const worker = createJobRunner({
      api: createApi({
        async createCapture() {
          calls.push('create');
          throw new Error('createCapture must not run for a recovered result_pending job');
        },
        async runOcrProxy() {
          calls.push('proxy');
          throw new Error('runOcrProxy must not run for a recovered result_pending job');
        },
        async submitOcrResult(input) {
          calls.push(`submit:${input.captureId}`);
          return createSubmitResponse();
        },
      }),
      readAssetBytes: async () => {
        calls.push('read-bytes');
        throw new Error('readAssetBytes must not run for a recovered result_pending job');
      },
      store,
    });

    const result = await worker.runOnce();

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      status: 'synced',
    });
    expect(calls).toEqual(['submit:capture_existing']);
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      serverCaptureId: 'capture_existing',
      state: 'synced',
      terminalReason: 'ocr_synced',
    });
  });

  it('settles metadata-only captures without running OCR', async () => {
    const store = createMemoryStore();
    await seedPendingCapture(store);
    const calls: string[] = [];
    const worker = createJobRunner({
      api: createApi({
        async createCapture(input) {
          calls.push(`create:${input.idempotencyKey}`);
          return {
            captureId: 'capture_1',
            nextAction: 'none',
            timelineEventId: 'timeline_1',
          };
        },
      }),
      store,
    });

    const result = await worker.runOnce();

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      status: 'synced',
    });
    expect(calls).toEqual(['create:idem_1']);
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      state: 'synced',
      terminalReason: 'metadata_synced',
    });
  });

  it('blocks jobs with a safe local asset reason when the asset ref row is missing', async () => {
    const store = createMemoryStore();
    const created = await store.createOutboxJob(createJob());
    expect(created.ok).toBe(true);
    const worker = createJobRunner({
      api: createApi({
        async createCapture() {
          throw new Error('createCapture must not run when the asset ref row is missing');
        },
      }),
      store,
    });

    const result = await worker.runOnce();

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      status: 'blocked',
    });
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      lastSafeError: {
        code: 'asset_ref_missing',
        message: 'Local asset reference is missing.',
        retryable: false,
      },
      state: 'blocked',
      terminalReason: 'asset_ref_missing',
    });
  });

  it('blocks local asset byte read failures without running the OCR proxy', async () => {
    const store = createMemoryStore();
    await seedPendingCapture(store);
    const calls: string[] = [];
    const worker = createJobRunner({
      api: createApi({
        async runOcrProxy() {
          calls.push('proxy');
          throw new Error('runOcrProxy must not run when local bytes are unreadable');
        },
      }),
      readAssetBytes: async () => {
        calls.push('read');
        throw Object.assign(new Error('/Users/alice/private.png permission denied'), {
          code: 'local_asset_unreadable',
          retryable: false,
          safeMessage: 'Local asset is unreadable.',
        });
      },
      store,
    });

    const result = await worker.runOnce();

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      status: 'blocked',
    });
    expect(calls).toEqual(['read']);
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      lastSafeError: {
        code: 'local_asset_unreadable',
        message: 'Local asset is unreadable.',
        retryable: false,
      },
      state: 'blocked',
      terminalReason: 'local_asset_unreadable',
    });
  });

  it('maps a provider_not_configured proxy failure to a fail-closed blocked state', async () => {
    const store = createMemoryStore();
    await seedPendingCapture(store);
    const worker = createJobRunner({
      api: createApi({
        async runOcrProxy() {
          throw new ServerApiError({
            code: 'provider_not_configured',
            retryable: false,
            safeMessage: 'Provider is not configured.',
          });
        },
      }),
      store,
    });

    const result = await worker.runOnce();

    expect(result).toMatchObject({ status: 'blocked' });
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      state: 'blocked',
      terminalReason: 'provider_not_configured',
    });
  });

  it('keeps provider_unavailable proxy failures and offline capture creation failures retryable', async () => {
    const providerStore = createMemoryStore();
    await seedPendingCapture(providerStore);
    const providerWorker = createJobRunner({
      api: createApi({
        async runOcrProxy() {
          throw new ServerApiError({
            code: 'provider_unavailable',
            retryable: true,
            safeMessage: 'Provider is unavailable.',
          });
        },
      }),
      store: providerStore,
    });

    const offlineStore = createMemoryStore();
    await seedPendingCapture(offlineStore);
    const offlineWorker = createJobRunner({
      api: createApi({
        async createCapture() {
          throw Object.assign(new Error('offline'), {
            code: 'offline',
            retryable: true,
            safeMessage: 'Network is offline.',
          });
        },
      }),
      store: offlineStore,
    });

    await providerWorker.runOnce();
    await offlineWorker.runOnce();

    expect(await providerStore.getOutboxJob('job_1')).toMatchObject({
      lastSafeError: {
        code: 'provider_unavailable',
        retryable: true,
      },
      state: 'pending',
    });
    expect(await offlineStore.getOutboxJob('job_1')).toMatchObject({
      lastSafeError: {
        code: 'offline',
        retryable: true,
      },
      state: 'pending',
    });
  });

  it('fails a job when the proxy rejects the input as too large', async () => {
    const store = createMemoryStore();
    await seedPendingCapture(store);
    const worker = createJobRunner({
      api: createApi({
        async runOcrProxy() {
          throw new ServerApiError({
            code: 'input_too_large',
            retryable: false,
            safeMessage: 'Input is too large.',
          });
        },
      }),
      store,
    });

    const result = await worker.runOnce();

    expect(result).toMatchObject({ status: 'failed' });
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      lastSafeError: {
        code: 'input_too_large',
        retryable: false,
      },
      state: 'failed',
      terminalReason: 'input_too_large',
    });
  });

  it('submits an empty screen-text result and syncs without a paid OCR retry', async () => {
    const store = createMemoryStore();
    await seedPendingCapture(store);
    let proxyCalls = 0;
    const submissions: Parameters<SyncServerApi['submitOcrResult']>[0][] = [];
    const worker = createJobRunner({
      api: createApi({
        async runOcrProxy() {
          proxyCalls += 1;
          return {
            blocks: [],
            durationMs: 900,
            model: 'test-model',
            providerName: 'test-provider',
            text: '',
          };
        },
        async submitOcrResult(input) {
          submissions.push(input);
          return createSubmitResponse();
        },
      }),
      store,
    });

    const result = await worker.runOnce();

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      status: 'synced',
    });
    expect(proxyCalls).toBe(1);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.screenText).toEqual({
      blocks: [],
      readingOrder: 'top_to_bottom_left_to_right',
      source: 'image_ocr',
    });
    const job = await store.getOutboxJob('job_1');
    expect(job).toMatchObject({
      attempt: 0,
      state: 'synced',
      terminalReason: 'ocr_synced',
    });
    expect(job?.lastSafeError).toBeUndefined();
  });

  it('retries only the submission and keeps the transcript when result submission fails', async () => {
    const store = createMemoryStore();
    await seedPendingCapture(store);
    let proxyCalls = 0;
    const worker = createJobRunner({
      api: createApi({
        async createCapture() {
          return {
            captureId: 'capture_1',
            inputAssetId: 'asset_server_1',
            nextAction: 'queue_ocr',
            timelineEventId: 'timeline_1',
          };
        },
        async runOcrProxy() {
          proxyCalls += 1;
          return createOcrResponse();
        },
        async submitOcrResult() {
          throw new ServerApiError({
            code: 'server_unavailable',
            retryable: true,
            safeMessage: 'Server is unavailable.',
            status: 503,
          });
        },
      }),
      store,
    });

    const result = await worker.runOnce();
    const job = await store.getOutboxJob('job_1');

    expect(result).toMatchObject({ status: 'retry_wait' });
    expect(proxyCalls).toBe(1);
    expect(job).toMatchObject({
      lastSafeError: {
        code: 'server_unavailable',
        retryable: true,
      },
      serverCaptureId: 'capture_1',
      state: 'pending',
    });
    // The transcript is retained so the retry resubmits without re-billing the
    // proxy (裁决 1 Option B).
    expect(job?.ocrResult).toMatchObject({
      sourceAssetHash: assetHash,
    });
  });

  it('does not revive a locally cancelled job after the proxy returns', async () => {
    const store = createMemoryStore();
    await seedPendingCapture(store);
    const worker = createJobRunner({
      api: createApi({
        async runOcrProxy() {
          await store.markOutboxJobTerminal('job_1', {
            now: '2026-07-06T00:00:03.000Z',
            reason: 'user_cancelled',
            state: 'cancelled',
          });
          return createOcrResponse();
        },
        async submitOcrResult() {
          throw new Error('submitOcrResult must not run for a locally cancelled job');
        },
      }),
      store,
    });

    const result = await worker.runOnce();

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      status: 'cancelled',
    });
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      state: 'cancelled',
      terminalReason: 'user_cancelled',
    });
  });

  it('treats block_ocr captures as metadata-only and never reads or proxies local bytes', async () => {
    const store = createMemoryStore();
    await seedPendingCapture(
      store,
      createJob({
        capture: {
          privacyDecision: {
            action: 'block_ocr',
            decidedAt: now,
            policyVersion: 'policy_desktop_1',
            reasons: ['domain_rule'],
          },
        },
      }),
    );
    const calls: string[] = [];
    const worker = createJobRunner({
      api: createApi({
        async createCapture() {
          calls.push('create');
          return {
            captureId: 'capture_1',
            inputAssetId: 'asset_server_1',
            nextAction: 'queue_ocr',
            timelineEventId: 'timeline_1',
          };
        },
        async runOcrProxy() {
          calls.push('proxy');
          throw new Error('runOcrProxy must not be called for block_ocr');
        },
      }),
      readAssetBytes: async () => {
        calls.push('read-bytes');
        throw new Error('readAssetBytes must not be called for block_ocr');
      },
      store,
    });

    const result = await worker.runOnce();

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      status: 'synced',
    });
    expect(calls).toEqual(['create']);
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      state: 'synced',
      terminalReason: 'ocr_blocked_by_local_policy',
    });
  });

  it('treats block_capture outbox jobs as metadata-only', async () => {
    const store = createMemoryStore();
    await seedPendingCapture(
      store,
      createJob({
        capture: {
          privacyDecision: {
            action: 'block_capture',
            decidedAt: now,
            policyVersion: 'policy_desktop_1',
            reasons: ['app_rule'],
          },
        },
      }),
    );
    const calls: string[] = [];
    const worker = createJobRunner({
      api: createApi({
        async createCapture() {
          calls.push('create');
          return {
            captureId: 'capture_1',
            inputAssetId: 'asset_server_1',
            nextAction: 'queue_ocr',
            timelineEventId: 'timeline_1',
          };
        },
        async runOcrProxy() {
          calls.push('proxy');
          throw new Error('runOcrProxy must not be called for block_capture');
        },
      }),
      readAssetBytes: async () => {
        calls.push('read-bytes');
        throw new Error('readAssetBytes must not be called for block_capture');
      },
      store,
    });

    const result = await worker.runOnce();

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      status: 'synced',
    });
    expect(calls).toEqual(['create']);
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      state: 'synced',
      terminalReason: 'capture_blocked_by_local_policy',
    });
  });

  it('redacts untrusted proxy error messages before storing errors or queue summaries', async () => {
    const store = createMemoryStore();
    await seedPendingCapture(store);
    const leakedText = 'Patient Magnolia Rivera belongs to Project Blue Meridian oncology plan.';
    const worker = createJobRunner({
      api: createApi({
        async runOcrProxy() {
          throw new ServerApiError({
            code: 'provider_timeout',
            retryable: true,
            safeMessage: `Bearer auth-token sk-provider-token /Users/alice/private.png ${leakedText}`,
          });
        },
      }),
      store,
    });

    await worker.runOnce();
    const job = await store.getOutboxJob('job_1');
    const summary = await createSyncQueueSummary(store, 'workspace_1');
    const serialized = JSON.stringify({ job, summary });

    expect(summary.lastError).toMatchObject({
      code: 'provider_unavailable',
      message: 'OCR provider timed out.',
      details: {
        safeCode: 'provider_timeout',
      },
    });
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('sk-provider-token');
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('Magnolia Rivera');
    expect(serialized).not.toContain('Project Blue Meridian');
    expect(serialized).not.toContain('oncology plan');
  });

  it('does not persist arbitrary server error messages in sync errors or summaries', async () => {
    const store = createMemoryStore();
    await seedPendingCapture(store);
    const leakedText = 'Patient Magnolia Rivera belongs to Project Blue Meridian oncology plan.';
    const worker = createJobRunner({
      api: createApi({
        async createCapture() {
          throw new ServerApiError({
            code: 'provider_unavailable',
            retryable: true,
            safeMessage: leakedText,
            status: 503,
          });
        },
      }),
      store,
    });

    await worker.runOnce();
    const job = await store.getOutboxJob('job_1');
    const summary = await createSyncQueueSummary(store, 'workspace_1');
    const serialized = JSON.stringify({ job, summary });

    expect(job?.lastSafeError).toMatchObject({
      code: 'provider_unavailable',
      message: 'Provider is unavailable.',
      retryable: true,
    });
    expect(summary.lastError).toMatchObject({
      code: 'provider_unavailable',
      message: 'Provider is unavailable.',
    });
    expect(serialized).not.toContain('Magnolia Rivera');
    expect(serialized).not.toContain('Project Blue Meridian');
    expect(serialized).not.toContain('oncology plan');
  });

  it('reconciles capture-only jobs to synced when server OCR already succeeded', async () => {
    const store = createMemoryStore();
    await seedPendingCapture(store);
    await store.updateOutboxJobState('job_1', {
      now: '2026-07-06T00:00:01.000Z',
      serverCaptureId: 'capture_existing',
      state: 'syncing',
    });
    // Recover it to pending so it can be claimed again for the reconcile pass.
    await store.recoverInterruptedOutboxJob({
      id: 'job_1',
      lastSafeError: {
        code: 'interrupted_during_sync',
        message: 'Outbox sync was interrupted before startup recovery.',
        retryable: true,
      },
      nextRetryAt: now,
      now,
    });
    const calls: string[] = [];
    const worker = createJobRunner({
      api: createApi({
        async getCapture(workspaceId, captureId) {
          calls.push(`capture:${workspaceId}:${captureId}`);
          return {
            captureId,
            ocrJobId: 'ocr_existing',
            ocrStatus: 'succeeded',
          };
        },
        async createCapture() {
          calls.push('create');
          throw new Error('createCapture must not run during capture reconcile');
        },
        async runOcrProxy() {
          calls.push('proxy');
          throw new Error('runOcrProxy must not run during capture reconcile');
        },
      }),
      store,
    });

    const result = await worker.runOnce();

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      status: 'synced',
    });
    expect(calls).toEqual(['capture:workspace_1:capture_existing']);
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      serverCaptureId: 'capture_existing',
      state: 'synced',
      terminalReason: 'ocr_synced',
    });
  });

  it('maps explanatory safe error codes to IPC summaries without collapsing them to unknown', async () => {
    const cases = [
      ['policy_denied', 'policy_denied', undefined],
      ['quota_exceeded', 'quota_exceeded', undefined],
      ['input_too_large', 'input_too_large', undefined],
      ['unsupported_format', 'unsupported_format', undefined],
      ['provider_rate_limited', 'provider_unavailable', 'provider_rate_limited'],
      ['provider_timeout', 'provider_unavailable', 'provider_timeout'],
    ] as const;

    for (const [safeCode, expectedIpcCode, expectedDetailsCode] of cases) {
      const store = createMemoryStore();
      await seedPendingCapture(store);
      await store.recordOutboxSafeError('job_1', {
        code: safeCode,
        maxAttempts: 3,
        message: `${safeCode} safe message`,
        now,
        retryable: false,
      });

      const summary = await createSyncQueueSummary(store, 'workspace_1');

      expect(summary.lastError).toMatchObject({
        code: expectedIpcCode,
        message: expectedSyncMessage(safeCode),
      });
      if (expectedDetailsCode) {
        expect(summary.lastError?.details).toEqual({
          safeCode: expectedDetailsCode,
        });
      }
    }
  });
});

const assetHash = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function createOcrResponse() {
  return {
    blocks: [{ kind: 'text', order: 0, text: 'hello world' }],
    durationMs: 1200,
    model: 'test-model',
    providerName: 'test-provider',
    text: 'hello world',
  };
}

function createSubmitResponse() {
  return {
    result: {
      createdAt: now,
      id: 'ocr_result_1',
      qualityFlags: [],
      resultVersion: 1,
      sourceAssetHash: assetHash,
    },
  };
}

function createStoredOcrResult(overrides: Partial<StoredOcrResult> = {}): StoredOcrResult {
  return {
    durationMs: 1200,
    model: 'test-model',
    providerName: 'test-provider',
    screenText: {
      blocks: [{ kind: 'text', readingOrder: 0, source: 'image_ocr', text: 'hello world' }],
      readingOrder: 'top_to_bottom_left_to_right',
      source: 'image_ocr',
    },
    sourceAssetHash: assetHash,
    ...overrides,
  };
}

async function seedPendingCapture(
  store: ReturnType<typeof createMemoryStore>,
  job: OutboxJobCreateInput = createJob(),
) {
  await store.upsertAssetCacheRef(createAsset());
  const created = await store.createOutboxJob(job);
  expect(created.ok).toBe(true);
}

function createJobRunner(input: {
  api: SyncServerApi;
  getWorkspaceId?: () => Promise<string | null>;
  readAssetBytes?: (localAccessKey: string) => Promise<Uint8Array>;
  store: ReturnType<typeof createMemoryStore>;
  workspaceId?: string | null;
}) {
  const executeJob = createSyncJobExecutor({
    api: input.api,
    clock: createClock(),
    maxAttempts: 3,
    readAssetBytes: input.readAssetBytes ?? (async () => new Uint8Array([1, 2, 3, 4])),
    retryBackoff: { baseMs: 60_000, factor: 2, jitterRatio: 0, maxMs: 300_000 },
    store: input.store,
    workspace: {
      getActiveWorkspaceId:
        input.getWorkspaceId ??
        (async () =>
          Object.hasOwn(input, 'workspaceId') ? (input.workspaceId ?? null) : 'workspace_1'),
    },
  });
  return {
    async runOnce() {
      const job = await input.store.claimNextRetryableOutboxJob({
        maxAttempts: 3,
        now,
        workspaceId: 'workspace_1',
      });
      if (!job) {
        throw new Error('Expected a retryable outbox job for the executor test.');
      }
      return executeJob(job);
    },
  };
}

function createApi(overrides: Partial<SyncServerApi> = {}): SyncServerApi {
  return {
    async getCapture() {
      return {
        captureId: 'capture_1',
        ocrStatus: 'not_requested',
      };
    },
    async createCapture() {
      return {
        captureId: 'capture_1',
        inputAssetId: 'asset_server_1',
        nextAction: 'queue_ocr',
        timelineEventId: 'timeline_1',
      };
    },
    async runOcrProxy() {
      return createOcrResponse();
    },
    async submitOcrResult() {
      return createSubmitResponse();
    },
    ...overrides,
  };
}

function expectedSyncMessage(code: string): string {
  if (code === 'policy_denied') {
    return 'Capture policy denied this request.';
  }

  if (code === 'quota_exceeded') {
    return 'Quota has been exceeded.';
  }

  if (code === 'input_too_large') {
    return 'Input is too large.';
  }

  if (code === 'unsupported_format') {
    return 'Input format is unsupported.';
  }

  if (code === 'provider_rate_limited') {
    return 'Provider is rate limited.';
  }

  if (code === 'provider_timeout') {
    return 'OCR provider timed out.';
  }

  return 'Sync failed.';
}

function createClock() {
  let tick = 0;
  return {
    now: () => `2026-07-06T00:00:0${tick++}.000Z`,
  };
}

function createJob(overrides: Partial<OutboxJobCreateInput> = {}): OutboxJobCreateInput {
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
    ...overrides,
  };
}

function createAsset(overrides: Partial<AssetCacheRef> = {}): AssetCacheRef {
  return {
    assetRefId: 'asset_ref_1',
    availabilityState: 'available',
    cleanupState: 'retained',
    createdAt: now,
    hash: assetHash,
    localAccessKey: 'content-addressed/local/asset_ref_1',
    mimeType: 'image/png',
    role: 'ocr_input',
    sizeBytes: 4,
    workspaceId: 'workspace_1',
    ...overrides,
  };
}

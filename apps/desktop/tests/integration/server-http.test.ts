import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiRuntime, RunVisionTextFailureReason } from '../../../server/src/ai/index';
import { projectAcceptanceQueue } from '../../src/acceptance/index';
import { type ServerApiTransport, createServerApiClient } from '../../src/server/index';
import {
  type AssetCacheRef,
  type OutboxJobCreateInput,
  createMemoryStore,
  createSqliteStore,
} from '../../src/storage/index';
import { createBunSqliteDatabase } from '../../src/storage/sqlite/bun';
import {
  type SyncQueueStore,
  type SyncServerApi,
  createSyncGate,
  createSyncJobExecutor,
  createSyncWorker,
} from '../../src/sync/index';
import {
  type ServerHttpHarness,
  type ServerHttpHarnessOptions,
  startServerHttpHarness as createServerHttpHarness,
} from '../support/server-http-harness';

const now = '2026-07-06T00:00:00.000Z';
const leakedProviderMessage =
  'Patient Magnolia Rivera belongs to Project Blue Meridian oncology plan.';

const activeHarnesses: ServerHttpHarness[] = [];
const activeTempDirs: string[] = [];
const activeProviders: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  const stopErrors: unknown[] = [];

  for (const harness of activeHarnesses.splice(0)) {
    try {
      harness.stop();
    } catch (error) {
      stopErrors.push(error);
    }
  }

  for (const provider of activeProviders.splice(0)) {
    try {
      provider.stop(true);
    } catch (error) {
      stopErrors.push(error);
    }
  }

  for (const dir of activeTempDirs.splice(0)) {
    try {
      rmSync(dir, { force: true, recursive: true });
    } catch (error) {
      stopErrors.push(error);
    }
  }

  if (stopErrors.length > 0) {
    throw new AggregateError(stopErrors, 'Failed to stop server HTTP harnesses.');
  }
});

describe('desktop server sync over real HTTP', () => {
  it('runs the OCR proxy and result submission through public /v1 routes and reads screen text from timeline/search', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const harness = await startHarness({
      aiRuntime: visionRuntimeReturning('Visible retention graph and roadmap notes'),
    });
    const user = await harness.bootstrapUser('desktop-positive@example.test');
    const store = createMemoryStore();
    await seedPendingCapture(store, user.workspaceId, bytes);
    const client = createHttpClient(harness.endpoint, user.accessToken);
    const worker = createWorker(store, client, user.workspaceId, bytes);

    const result = await worker.runOnce();
    const timeline = await client.queryTimeline({ workspaceId: user.workspaceId, limit: 10 });
    const search = await client.querySearch({
      workspaceId: user.workspaceId,
      query: 'retention',
      limit: 10,
    });

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      providerOutcome: 'succeeded',
      status: 'synced',
    });
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      serverCaptureId: expect.any(String),
      state: 'synced',
      terminalReason: 'ocr_synced',
    });
    // This fixture deliberately omits activity. The server must keep the
    // capture's safe title and must not invent a placeholder activity label.
    expect(timeline.items).toEqual([
      expect.objectContaining({
        sourceApp: 'Code',
        title: 'Retention Review',
      }),
    ]);
    expect(search.items).toEqual([
      expect.objectContaining({
        snippet: 'Visible retention graph and roadmap notes',
        sourceApp: 'Code',
        title: 'Retention Review',
      }),
    ]);
    expect(harness.captureSnapshot().searchDocuments).toHaveLength(1);
  });

  it('runs the OCR proxy over real HTTP with a SQLite-backed desktop store', async () => {
    const bytes = new Uint8Array([21, 22, 23, 24]);
    const harness = await startHarness({
      aiRuntime: visionRuntimeReturning('SQLite backed OCR searchable invoice'),
    });
    const user = await harness.bootstrapUser('desktop-sqlite-positive@example.test');
    const store = await createSqliteTestStore();
    await seedPendingCapture(store, user.workspaceId, bytes);
    const client = createHttpClient(harness.endpoint, user.accessToken);
    const worker = createWorker(store, client, user.workspaceId, bytes);

    const result = await worker.runOnce();
    const search = await client.querySearch({
      workspaceId: user.workspaceId,
      query: 'invoice',
      limit: 10,
    });

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      providerOutcome: 'succeeded',
      status: 'synced',
    });
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      serverCaptureId: expect.any(String),
      state: 'synced',
      terminalReason: 'ocr_synced',
    });
    expect(search.items).toEqual([
      expect.objectContaining({
        snippet: 'SQLite backed OCR searchable invoice',
        title: 'Retention Review',
      }),
    ]);
    expect(harness.captureSnapshot().searchDocuments).toHaveLength(1);
  });

  it('rejects missing privacyDecision.decidedAt before transport and at the server HTTP route', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const harness = await startHarness({
      aiRuntime: visionRuntimeReturning('Contract guard OCR'),
    });
    const user = await harness.bootstrapUser('desktop-contract@example.test');
    const client = createHttpClient(harness.endpoint, user.accessToken);

    await expect(
      client.createCapture({
        appName: 'Code',
        asset: createAsset(user.workspaceId, bytes),
        captureType: 'screen',
        capturedAt: now,
        deviceId: 'device_1',
        idempotencyKey: 'contract-missing-decided-at',
        observedAt: now,
        privacyDecision: {
          action: 'allow',
          policyVersion: 'policy_desktop_1',
          reasons: [],
        } as never,
        workspaceId: user.workspaceId,
      }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      retryable: false,
    });

    const serverResponse = await fetch(`${harness.endpoint}/v1/captures`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...captureHttpPayload(user.workspaceId, bytes),
        privacyDecision: {
          action: 'allow',
          policyVersion: 'policy_desktop_1',
          reasons: [],
        },
      }),
    });
    const body = await serverResponse.json();

    expect(serverResponse.status).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: 'validation.invalid_input',
      },
    });
    expect(harness.captureSnapshot().captures).toHaveLength(0);
  });

  it('fails closed when the real server reports provider_not_configured and writes no search result', async () => {
    const bytes = new Uint8Array([5, 6, 7, 8]);
    const harness = await startHarness({ useAppDefaultOcrRunner: true });
    const user = await harness.bootstrapUser('desktop-provider-missing@example.test');
    const store = createMemoryStore();
    await seedPendingCapture(store, user.workspaceId, bytes);
    const client = createHttpClient(harness.endpoint, user.accessToken);
    const worker = createWorker(store, client, user.workspaceId, bytes);

    const result = await worker.runOnce();
    const search = await client.querySearch({
      workspaceId: user.workspaceId,
      query: 'anything',
      limit: 10,
    });

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      status: 'blocked',
    });
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      state: 'blocked',
      terminalReason: 'provider_not_configured',
    });
    expect(search.items).toEqual([]);
    expect(harness.captureSnapshot().searchDocuments).toHaveLength(0);
  });

  it('keeps provider timeouts retryable without exposing provider text to desktop state or search', async () => {
    const bytes = new Uint8Array([9, 10, 11, 12]);
    const harness = await startHarness({
      aiRuntime: visionRuntimeFailing('provider_timeout', true, leakedProviderMessage),
    });
    const user = await harness.bootstrapUser('desktop-provider-timeout@example.test');
    const store = createMemoryStore();
    await seedPendingCapture(store, user.workspaceId, bytes);
    const client = createHttpClient(harness.endpoint, user.accessToken);
    const worker = createWorker(store, client, user.workspaceId, bytes);

    const result = await worker.runOnce();
    const job = await store.getOutboxJob('job_1');
    const search = await client.querySearch({
      workspaceId: user.workspaceId,
      query: 'Magnolia',
      limit: 10,
    });
    const serialized = JSON.stringify({ job, search });

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      status: 'retry_wait',
    });
    expect(job).toMatchObject({
      lastSafeError: {
        code: 'provider_timeout',
        message: 'OCR provider timed out.',
        retryable: true,
      },
      state: 'pending',
    });
    expect(search.items).toEqual([]);
    expect(serialized).not.toContain(leakedProviderMessage);
    expect(serialized).not.toContain('Magnolia Rivera');
    expect(serialized).not.toContain('Project Blue Meridian');
    expect(serialized).not.toContain('oncology plan');
    expect(harness.captureSnapshot().searchDocuments).toHaveLength(0);
  });

  it('pauses an invalid provider model and drains the original SQLite job through one half-open probe', async () => {
    const secret = 'provider-e2e-secret-should-not-leak';
    const providerBody =
      'private provider failure /Users/private/capture.webp sensitive prompt should-not-leak';
    const requests: Array<{ authorization: string | null; model: string | null }> = [];
    let rejectPreviouslyValidatedModel = false;
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { model?: unknown };
        const model = typeof body.model === 'string' ? body.model : null;
        requests.push({ authorization: request.headers.get('authorization'), model });
        if (rejectPreviouslyValidatedModel && model === 'validated-vision-model') {
          return new Response(providerBody, { status: 404 });
        }
        return new Response(
          `data: ${JSON.stringify({
            id: 'provider-e2e-success',
            object: 'chat.completion.chunk',
            created: 1,
            model,
            choices: [
              {
                index: 0,
                delta: {
                  content:
                    '{"screenText":{"text":"Recovered OCR text","blocks":[{"text":"Recovered OCR text","order":0,"kind":"line"}]}}',
                },
                finish_reason: 'stop',
              },
            ],
          })}\n\ndata: [DONE]\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      },
    });
    activeProviders.push(provider);
    const harness = await startHarness({ useAppDefaultOcrRunner: true });
    const user = await harness.bootstrapUser('desktop-provider-gate@example.test');
    const createSetting = await fetch(`${harness.endpoint}/v1/admin/provider-settings`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${user.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        service: 'ocr',
        provider: 'openai-compatible',
        endpoint: `${provider.url.toString().replace(/\/$/, '')}/v1`,
        model: 'validated-vision-model',
        secret,
      }),
    });
    expect(createSetting.status).toBe(201);
    const setting = (await createSetting.json()) as { setting: { id: string } };
    expect(requests).toHaveLength(1);
    rejectPreviouslyValidatedModel = true;
    const bytes = new Uint8Array([31, 32, 33, 34]);
    const store = await createSqliteTestStore();
    await seedPendingCapture(store, user.workspaceId, bytes);
    const client = createHttpClient(harness.endpoint, user.accessToken);
    const gate = createSyncGate({ probeDelayMs: 60_000 });
    let clockNowMs = Date.parse(now);
    const worker = createWorker(store, client, user.workspaceId, bytes, undefined, gate, () =>
      new Date(clockNowMs).toISOString(),
    );

    expect(await worker.runOnce()).toMatchObject({
      code: 'provider_configuration_invalid',
      status: 'retry_wait',
    });
    const pausedJob = await store.getOutboxJob('job_1');
    expect(pausedJob).toMatchObject({
      attempt: 0,
      lastSafeError: { code: 'provider_configuration_invalid', retryable: true },
      state: 'pending',
    });
    expect(gate.getStatus()).toMatchObject({
      reason: 'provider_configuration_invalid',
      state: 'paused',
    });
    expect(await worker.runOnce()).toMatchObject({ code: 'sync_paused', processed: 0 });
    expect(requests).toHaveLength(2);

    const updateSetting = await fetch(
      `${harness.endpoint}/v1/admin/provider-settings/${setting.setting.id}`,
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${user.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'replacement-vision-model' }),
      },
    );
    const updateBody = await updateSetting.text();
    expect(updateSetting.status).toBe(200);
    expect(requests).toHaveLength(3);

    clockNowMs += 60_000;
    const probeResults = await Promise.all([worker.runOnce(), worker.runOnce()]);
    expect(probeResults).toContainEqual({
      jobId: 'job_1',
      processed: 1,
      providerOutcome: 'succeeded',
      status: 'synced',
    });
    expect(probeResults).toContainEqual({ code: 'sync_paused', processed: 0, status: 'skipped' });
    expect(gate.getStatus()).toEqual({ state: 'open' });
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      attempt: 0,
      state: 'synced',
      terminalReason: 'ocr_synced',
    });
    expect(requests).toHaveLength(4);
    expect(requests.map((request) => request.model)).toEqual([
      'validated-vision-model',
      'validated-vision-model',
      'replacement-vision-model',
      'replacement-vision-model',
    ]);
    expect(requests.every((request) => request.authorization === `Bearer ${secret}`)).toBe(true);

    const projection = projectAcceptanceQueue(
      [pausedJob as NonNullable<typeof pausedJob>],
      Date.parse('2026-07-06T00:01:00.000Z'),
    );
    const persisted = JSON.stringify({ pausedJob, projection, updateBody });
    for (const unsafe of [secret, providerBody, '/Users/private', 'sensitive prompt']) {
      expect(persisted).not.toContain(unsafe);
    }
  });

  it('cancels an in-flight job as a purely local terminal state with no server OCR result', async () => {
    const bytes = new Uint8Array([13, 14, 15, 16]);
    const harness = await startHarness({
      aiRuntime: visionRuntimeReturning('This OCR must not be submitted'),
    });
    const user = await harness.bootstrapUser('desktop-cancel@example.test');
    const store = createMemoryStore();
    await seedPendingCapture(store, user.workspaceId, bytes);
    // Simulate a job that has been claimed and created (in-flight) when the
    // user cancels it: the thin-proxy model has no server-side OCR job to
    // cancel, so cancellation is purely local.
    await store.updateOutboxJobState('job_1', {
      now,
      serverCaptureId: 'capture_local',
      state: 'syncing',
    });
    const client = createHttpClient(harness.endpoint, user.accessToken);
    const worker = createWorker(store, client, user.workspaceId, bytes);

    const cancel = await worker.cancel('job_1', 'user_cancelled');

    expect(cancel).toEqual({ cancelled: true, jobId: 'job_1' });
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      state: 'cancelled',
      terminalReason: 'user_cancelled',
    });
    expect(harness.captureSnapshot().ocrResults).toHaveLength(0);
    expect(harness.captureSnapshot().searchDocuments).toHaveLength(0);
  });

  it('does not read local bytes or call the proxy for block_ocr over real HTTP', async () => {
    const bytes = new Uint8Array([17, 18, 19, 20]);
    const harness = await startHarness({
      aiRuntime: visionRuntimeReturning('This OCR must not run'),
    });
    const user = await harness.bootstrapUser('desktop-block-ocr@example.test');
    const store = createMemoryStore();
    await seedPendingCapture(store, user.workspaceId, bytes, {
      capture: {
        privacyDecision: {
          action: 'block_ocr',
          decidedAt: now,
          policyVersion: 'policy_desktop_1',
          reasons: ['domain_rule'],
        },
      },
    });
    const client = createHttpClient(harness.endpoint, user.accessToken);
    const worker = createWorker(store, client, user.workspaceId, bytes, async () => {
      throw new Error('block_ocr must not read local bytes');
    });

    const result = await worker.runOnce();

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      status: 'synced',
    });
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      state: 'synced',
      terminalReason: 'ocr_blocked_by_local_policy',
    });
    expect(harness.captureSnapshot().ocrResults).toHaveLength(0);
    expect(harness.captureSnapshot().searchDocuments).toHaveLength(0);
  });
});

const fetchTransport: ServerApiTransport = async (request) => {
  const headers = new Headers(request.headers);
  const response = await fetch(request.url, {
    body: encodeRequestBody(request.body, headers),
    headers,
    method: request.method,
  });

  return {
    body: await decodeResponseBody(response),
    headers: Object.fromEntries(response.headers.entries()),
    status: response.status,
  };
};

function createHttpClient(endpoint: string, accessToken: string) {
  return createServerApiClient({
    accessTokenProvider: {
      getAccessToken: async () => accessToken,
    },
    endpoint,
    transport: fetchTransport,
  });
}

function createWorker(
  store: SyncQueueStore,
  api: SyncServerApi,
  workspaceId: string,
  bytes: Uint8Array,
  readAssetBytes: () => Promise<Uint8Array> = async () => bytes,
  gate?: ReturnType<typeof createSyncGate>,
  nowSource?: () => string,
) {
  let tick = 0;
  const clock = {
    now: () => nowSource?.() ?? `2026-07-06T00:00:0${tick++}.000Z`,
  };
  const workspace = {
    getActiveWorkspaceId: async () => workspaceId,
  };
  const executeJob = createSyncJobExecutor({
    api,
    clock,
    maxAttempts: 3,
    readAssetBytes,
    retryBackoff: { baseMs: 60_000, factor: 2, jitterRatio: 0, maxMs: 300_000 },
    store,
    workspace,
  });
  return createSyncWorker({
    clock,
    executeJob,
    ...(gate ? { gate } : {}),
    maxAttempts: 3,
    store,
    workspace,
  });
}

async function seedPendingCapture(
  store: SyncFixtureStore,
  workspaceId: string,
  bytes: Uint8Array,
  overrides: Partial<OutboxJobCreateInput> = {},
) {
  await store.upsertAssetCacheRef(createAsset(workspaceId, bytes));
  const created = await store.createOutboxJob({
    assetRefId: 'asset_ref_1',
    capture: {
      appName: 'Code',
      bundleId: 'com.microsoft.VSCode',
      captureType: 'screen',
      capturedAt: now,
      contextConfidence: 'high',
      contextFingerprint: 'sha256:context-fingerprint-desktop-http',
      documentPathCandidate: {
        displayName: 'Retention Review.md',
        hash: 'sha256:document-hash-desktop-http',
        kind: 'safe',
      },
      localEventId: 'local-event-desktop-http',
      observedAt: now,
      privacyDecision: {
        action: 'allow',
        decidedAt: now,
        policyVersion: 'policy_desktop_1',
        reasons: [],
      },
      urlCandidate: {
        domain: 'example.test',
        kind: 'safe',
        normalized: 'https://example.test/retention',
      },
      windowTitleCandidate: {
        kind: 'safe',
        value: 'Retention Review',
      },
      ...overrides.capture,
    },
    createdAt: now,
    deviceId: 'device_1',
    id: 'job_1',
    idempotencyKey: 'desktop-http-idempotency-key',
    payloadHash: sha256Hex(new TextEncoder().encode('desktop-http-payload')),
    workspaceId,
    ...overrides,
  });
  expect(created.ok).toBe(true);
}

async function createSqliteTestStore(): Promise<ReturnType<typeof createSqliteStore>> {
  const dir = mkdtempSync(join(tmpdir(), 'recapsy-desktop-http-sqlite-'));
  activeTempDirs.push(dir);
  const store = createSqliteStore({
    database: createBunSqliteDatabase(join(dir, 'operational.sqlite')),
  });
  await store.initialize();
  return store;
}

type SyncFixtureStore = SyncQueueStore &
  Pick<ReturnType<typeof createMemoryStore>, 'createOutboxJob' | 'upsertAssetCacheRef'>;

function createAsset(workspaceId: string, bytes: Uint8Array): AssetCacheRef {
  return {
    assetRefId: 'asset_ref_1',
    availabilityState: 'available',
    cleanupState: 'retained',
    createdAt: now,
    hash: sha256Hex(bytes),
    localAccessKey: 'content-addressed/local/asset_ref_1',
    mimeType: 'image/png',
    role: 'ocr_input',
    sizeBytes: bytes.byteLength,
    workspaceId,
  };
}

function captureHttpPayload(workspaceId: string, bytes: Uint8Array) {
  return {
    appName: 'Code',
    captureType: 'screen',
    capturedAt: now,
    contentHash: sha256Hex(bytes),
    contextConfidence: 'high',
    deviceId: 'device_1',
    idempotencyKey: 'server-contract-missing-decided-at',
    localAssets: [
      {
        availability: 'available',
        byteSize: bytes.byteLength,
        contentHash: sha256Hex(bytes),
        localDeviceAssetRef: 'asset_ref_1',
        mimeType: 'image/png',
        role: 'ocr_input_image',
      },
    ],
    observedAt: now,
    privacyDecision: {
      action: 'allow',
      decidedAt: now,
      policyVersion: 'policy_desktop_1',
      reasons: [],
    },
    workspaceId,
  };
}

function encodeRequestBody(body: unknown, headers: Headers): BodyInit | undefined {
  if (body === undefined) {
    return undefined;
  }

  if (body instanceof Uint8Array) {
    const buffer = new ArrayBuffer(body.byteLength);
    new Uint8Array(buffer).set(body);
    return buffer;
  }

  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  return JSON.stringify(body);
}

async function decodeResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }

  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    return await response.json();
  }

  const text = await response.text();
  return text ? { text } : undefined;
}

function sha256Hex(bytes: Uint8Array) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function startHarness(options: ServerHttpHarnessOptions = {}): Promise<ServerHttpHarness> {
  const harness = await createServerHttpHarness(options);
  activeHarnesses.push(harness);
  return harness;
}

function visionRuntimeReturning(text: string): AiRuntime {
  return {
    async runText() {
      throw new Error('Unexpected AI text request in vision test harness.');
    },
    async runVisionText() {
      return {
        blocks: [{ kind: 'line', order: 0, text }],
        durationMs: 5,
        model: 'fake-vision-model',
        providerName: 'fake-provider',
        providerSettingId: 'fake-provider-setting',
        success: true,
        text,
        activity: {
          activitySummary: null,
          entities: [],
          actionHints: [],
          embeddingCandidateText: null,
        },
        activityStatus: 'omitted',
      };
    },
    async runEmbedding() {
      return {
        durationMs: 1,
        embeddings: [],
        model: 'fake-embed-model',
        providerName: 'fake-provider',
        providerSettingId: 'fake-provider-setting',
        success: true,
      };
    },
  };
}

function visionRuntimeFailing(
  reason: RunVisionTextFailureReason,
  retryable: boolean,
  safeMessage: string,
): AiRuntime {
  return {
    async runText() {
      throw new Error('Unexpected AI text request in vision test harness.');
    },
    async runVisionText() {
      return { reason, retryable, safeMessage, success: false };
    },
    async runEmbedding() {
      return { reason: 'unknown', retryable: false, safeMessage, success: false };
    },
  };
}

import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { createTestHttpApp } from '../../server/src/__tests__/app-harness';
import type { InMemoryAccountManagementRepository } from '../../server/src/account-management/repositories/memory';
import type {
  AiRuntime,
  RunVisionTextFailureReason,
  createAiRuntime,
} from '../../server/src/ai/public';
import type { CaptureOcrSearchRepositorySnapshot } from '../../server/src/capture-ocr-search/models';
import type { InMemoryCaptureOcrSearchRepository } from '../../server/src/capture-ocr-search/repositories/memory';
import type { createProviderCredentialResolver } from '../../server/src/provider-settings/public';
import type { Logger } from '../../server/src/shared/logger';
import { createServerApiClient } from '../src/server/client';
import type { ServerApiTransport } from '../src/server/types';
import { createMemoryStore, createSqliteStore } from '../src/storage';
import type {
  AssetCacheRef,
  OperationalStoreRepository,
  OutboxJobCreateInput,
} from '../src/storage';
import { createBunSqliteDatabase } from '../src/storage/bun-driver';
import { createSyncScheduler } from '../src/sync/scheduler';
import type { SyncServerApi } from '../src/sync/types';

const now = '2026-07-06T00:00:00.000Z';
const adminToken = 'test-admin-bootstrap-token';
const sessionSecret = 'test-session-secret-with-enough-entropy';
const providerSecret = 'test-provider-secret-with-enough-entropy';
const leakedProviderMessage =
  'Patient Magnolia Rivera belongs to Project Blue Meridian oncology plan.';

const activeHarnesses: ServerHttpHarness[] = [];
const activeTempDirs: string[] = [];

afterEach(() => {
  const stopErrors: unknown[] = [];

  for (const harness of activeHarnesses.splice(0)) {
    try {
      harness.stop();
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
    const harness = await startServerHttpHarness({
      aiRuntime: visionRuntimeReturning('Visible retention graph and roadmap notes'),
    });
    const user = await harness.bootstrapUser('desktop-positive@example.test');
    const store = createMemoryStore();
    await seedPendingCapture(store, user.workspaceId, bytes);
    const client = createHttpClient(harness.endpoint, user.accessToken);
    const scheduler = createScheduler(store, client, user.workspaceId, bytes);

    const result = await scheduler.runOnce();
    const timeline = await client.queryTimeline({ workspaceId: user.workspaceId, limit: 10 });
    const search = await client.querySearch({
      workspaceId: user.workspaceId,
      query: 'retention',
      limit: 10,
    });

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      status: 'synced',
    });
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      serverCaptureId: expect.any(String),
      state: 'synced',
      terminalReason: 'ocr_synced',
    });
    // The thin-proxy flow submits screen text only; the server synthesizes a
    // fixed activity placeholder (裁决 8), so the timeline summary/title is the
    // placeholder rather than a generated activity label.
    expect(timeline.items).toEqual([
      expect.objectContaining({
        snippet: 'Processed screenshot OCR',
        sourceApp: 'Code',
        title: 'Processed screenshot OCR',
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
    const harness = await startServerHttpHarness({
      aiRuntime: visionRuntimeReturning('SQLite backed OCR searchable invoice'),
    });
    const user = await harness.bootstrapUser('desktop-sqlite-positive@example.test');
    const store = await createSqliteTestStore();
    await seedPendingCapture(store, user.workspaceId, bytes);
    const client = createHttpClient(harness.endpoint, user.accessToken);
    const scheduler = createScheduler(store, client, user.workspaceId, bytes);

    const result = await scheduler.runOnce();
    const search = await client.querySearch({
      workspaceId: user.workspaceId,
      query: 'invoice',
      limit: 10,
    });

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
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
    const harness = await startServerHttpHarness({
      aiRuntime: visionRuntimeReturning('Contract guard OCR'),
    });
    const user = await harness.bootstrapUser('desktop-contract@example.test');
    const client = createHttpClient(harness.endpoint, user.accessToken);

    await expect(
      client.ingestCapture({
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

    const serverResponse = await fetch(`${harness.endpoint}/v1/captures/ingest`, {
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
    const harness = await startServerHttpHarness({ useAppDefaultOcrRunner: true });
    const user = await harness.bootstrapUser('desktop-provider-missing@example.test');
    const store = createMemoryStore();
    await seedPendingCapture(store, user.workspaceId, bytes);
    const client = createHttpClient(harness.endpoint, user.accessToken);
    const scheduler = createScheduler(store, client, user.workspaceId, bytes);

    const result = await scheduler.runOnce();
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
    const harness = await startServerHttpHarness({
      aiRuntime: visionRuntimeFailing('provider_timeout', true, leakedProviderMessage),
    });
    const user = await harness.bootstrapUser('desktop-provider-timeout@example.test');
    const store = createMemoryStore();
    await seedPendingCapture(store, user.workspaceId, bytes);
    const client = createHttpClient(harness.endpoint, user.accessToken);
    const scheduler = createScheduler(store, client, user.workspaceId, bytes);

    const result = await scheduler.runOnce();
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

  it('cancels an in-flight job as a purely local terminal state with no server OCR result', async () => {
    const bytes = new Uint8Array([13, 14, 15, 16]);
    const harness = await startServerHttpHarness({
      aiRuntime: visionRuntimeReturning('This OCR must not be submitted'),
    });
    const user = await harness.bootstrapUser('desktop-cancel@example.test');
    const store = createMemoryStore();
    await seedPendingCapture(store, user.workspaceId, bytes);
    // Simulate a job that has been claimed and ingested (in-flight) when the
    // user cancels it: the thin-proxy model has no server-side OCR job to
    // cancel, so cancellation is purely local.
    await store.updateOutboxJobState('job_1', {
      now,
      serverCaptureId: 'capture_local',
      state: 'syncing',
    });
    const client = createHttpClient(harness.endpoint, user.accessToken);
    const scheduler = createScheduler(store, client, user.workspaceId, bytes);

    const cancel = await scheduler.cancel('job_1', 'user_cancelled');

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
    const harness = await startServerHttpHarness({
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
    const scheduler = createScheduler(store, client, user.workspaceId, bytes, async () => {
      throw new Error('block_ocr must not read local bytes');
    });

    const result = await scheduler.runOnce();

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

function createScheduler(
  store: OperationalStoreRepository,
  api: SyncServerApi,
  workspaceId: string,
  bytes: Uint8Array,
  readAssetBytes: () => Promise<Uint8Array> = async () => bytes,
) {
  let tick = 0;
  return createSyncScheduler({
    api,
    clock: {
      now: () => `2026-07-06T00:00:0${tick++}.000Z`,
    },
    maxAttempts: 3,
    readAssetBytes,
    retryBackoff: { baseMs: 60_000, factor: 2, jitterRatio: 0, maxMs: 300_000 },
    store,
    workspace: {
      getActiveWorkspaceId: async () => workspaceId,
    },
  });
}

async function seedPendingCapture(
  store: OperationalStoreRepository,
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

async function createSqliteTestStore(): Promise<OperationalStoreRepository> {
  const dir = mkdtempSync(join(tmpdir(), 'recapsy-desktop-http-sqlite-'));
  activeTempDirs.push(dir);
  const store = createSqliteStore({
    database: createBunSqliteDatabase(join(dir, 'operational.sqlite')),
  });
  await store.initialize();
  return store;
}

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

type ServerHttpHarness = {
  endpoint: string;
  bootstrapUser(email: string): Promise<{ accessToken: string; workspaceId: string }>;
  captureSnapshot(): CaptureOcrSearchRepositorySnapshot;
  stop(): void;
};

type ServerHarnessOptions = {
  aiRuntime?: AiRuntime;
  useAppDefaultOcrRunner?: boolean;
};

type ServerModules = {
  InMemoryAccountManagementRepository: new () => InMemoryAccountManagementRepository;
  InMemoryCaptureOcrSearchRepository: new () => InMemoryCaptureOcrSearchRepository;
  createProviderCredentialResolver: typeof createProviderCredentialResolver;
  createAiRuntime: typeof createAiRuntime;
  createTestHttpApp: typeof createTestHttpApp;
};

async function startServerHttpHarness(options: ServerHarnessOptions): Promise<ServerHttpHarness> {
  const modules = await loadServerModules();
  let server: ReturnType<typeof Bun.serve> | undefined;

  try {
    const accountManagementRepository = new modules.InMemoryAccountManagementRepository();
    const captureOcrSearchRepository = new modules.InMemoryCaptureOcrSearchRepository();
    const config = {
      ADMIN_BOOTSTRAP_TOKEN: adminToken,
      CORS_ALLOWED_ORIGINS: [],
      DATABASE_URL: 'postgresql://test',
      EMBEDDING_INDEXER_BATCH_SIZE: 16,
      EMBEDDING_INDEXER_INTERVAL_MS: 15_000,
      EMBEDDING_INDEXER_MAX_ATTEMPTS: 5,
      EMBEDDING_INDEXER_TIMEOUT_MS: 30_000,
      LOG_LEVEL: 'error' as const,
      NODE_ENV: options.useAppDefaultOcrRunner ? ('production' as const) : ('test' as const),
      OCR_MAX_INPUT_BYTES: 1024 * 1024,
      OCR_PROXY_MAX_INFLIGHT_PER_USER: 2,
      PORT: 0,
      PROVIDER_ENCRYPTION_SECRET: providerSecret,
      SESSION_SECRET: sessionSecret,
    };
    const logger = {
      debug() {},
      error() {},
      info() {},
      warn() {},
    } as unknown as Logger;
    const aiRuntime =
      options.aiRuntime ??
      (options.useAppDefaultOcrRunner
        ? modules.createAiRuntime({
            providerCredentialResolver: modules.createProviderCredentialResolver({
              config,
              repository: accountManagementRepository,
            }),
          })
        : undefined);
    const app = modules.createTestHttpApp({
      accountManagementRepository,
      ...(aiRuntime ? { aiRuntime } : {}),
      captureOcrSearchRepository,
      config,
      logger,
    }).app;
    server = Bun.serve({
      fetch: app.fetch,
      port: 0,
    });
    const endpoint = server.url.toString().replace(/\/$/, '');
    const harness: ServerHttpHarness = {
      endpoint,
      async bootstrapUser(email) {
        const inviteRes = await fetch(`${endpoint}/v1/bootstrap/invites`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${adminToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            initialQuota: { ocrJobsPerMonth: 100, searchQueriesPerMonth: 1000 },
            initialTrialDays: 14,
            note: 'Desktop HTTP sync smoke',
          }),
        });
        expect(inviteRes.status).toBe(201);
        const invite = (await inviteRes.json()) as { code: string };
        const registerRes = await fetch(`${endpoint}/v1/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email,
            inviteCode: invite.code,
            password: 'correct horse battery staple',
          }),
        });
        expect(registerRes.status).toBe(201);
        const registered = (await registerRes.json()) as {
          session: { currentWorkspace: { id: string } };
          tokens: { accessToken: string };
        };
        return {
          accessToken: registered.tokens.accessToken,
          workspaceId: registered.session.currentWorkspace.id,
        };
      },
      captureSnapshot() {
        return captureOcrSearchRepository.snapshot();
      },
      stop() {
        server?.stop(true);
        server = undefined;
      },
    };
    activeHarnesses.push(harness);
    return harness;
  } catch (error) {
    server?.stop(true);
    throw error;
  }
}

async function loadServerModules(): Promise<ServerModules> {
  const appHarnessModule = await import(
    new URL('../../server/src/__tests__/app-harness.ts', import.meta.url).href
  );
  const aiRuntimeModule = await import(
    new URL('../../server/src/ai/public.ts', import.meta.url).href
  );
  const accountRepositoryModule = await import(
    new URL('../../server/src/account-management/repositories/memory.ts', import.meta.url).href
  );
  const captureRepositoryModule = await import(
    new URL('../../server/src/capture-ocr-search/repositories/memory.ts', import.meta.url).href
  );
  const providerSettingsModule = await import(
    new URL('../../server/src/provider-settings/public.ts', import.meta.url).href
  );

  return {
    InMemoryAccountManagementRepository:
      accountRepositoryModule.InMemoryAccountManagementRepository,
    InMemoryCaptureOcrSearchRepository: captureRepositoryModule.InMemoryCaptureOcrSearchRepository,
    createProviderCredentialResolver: providerSettingsModule.createProviderCredentialResolver,
    createAiRuntime: aiRuntimeModule.createAiRuntime,
    createTestHttpApp: appHarnessModule.createTestHttpApp,
  };
}

function visionRuntimeReturning(text: string): AiRuntime {
  return {
    async runVisionText() {
      return {
        blocks: [{ kind: 'line', order: 0, text }],
        durationMs: 5,
        model: 'fake-vision-model',
        providerName: 'fake-provider',
        providerSettingId: 'fake-provider-setting',
        success: true,
        text,
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
    async runVisionText() {
      return { reason, retryable, safeMessage, success: false };
    },
    async runEmbedding() {
      return { reason: 'unknown', retryable: false, safeMessage, success: false };
    },
  };
}

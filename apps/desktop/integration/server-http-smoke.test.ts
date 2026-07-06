import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInMemoryTokenStore } from '../src/auth/token-store';
import { createServerApiClient } from '../src/server-api/client';
import type { ServerApiClient, ServerApiTransport } from '../src/server-api/types';
import { createInMemoryOperationalStore } from '../src/storage';
import type { AssetCacheRef, OutboxJobCreateInput } from '../src/storage';
import { createSyncScheduler } from '../src/sync/scheduler';

const now = '2026-07-06T00:00:00.000Z';
const adminToken = 'test-admin-bootstrap-token';
const sessionSecret = 'test-session-secret-with-enough-entropy';
const providerSecret = 'test-provider-secret-with-enough-entropy';
const leakedProviderMessage =
  'Patient Magnolia Rivera belongs to Project Blue Meridian oncology plan.';

const activeHarnesses: ServerHttpHarness[] = [];

afterEach(() => {
  const stopErrors: unknown[] = [];

  for (const harness of activeHarnesses.splice(0)) {
    try {
      harness.stop();
    } catch (error) {
      stopErrors.push(error);
    }
  }

  if (stopErrors.length > 0) {
    throw new AggregateError(stopErrors, 'Failed to stop server HTTP harnesses.');
  }
});

describe('desktop server sync over real HTTP', () => {
  it('syncs capture OCR through public /v1 routes and reads faithful text from timeline/search', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const harness = await startServerHttpHarness({
      ocrRunner: fixedOcrRunner('Visible retention graph and roadmap notes', 'Retention review'),
    });
    const user = await harness.bootstrapUser('desktop-positive@example.test');
    const store = createInMemoryOperationalStore();
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
    const serialized = JSON.stringify({ search, timeline });

    expect(result).toEqual({
      jobId: 'job_1',
      processed: 1,
      status: 'synced',
    });
    expect(await store.getOutboxJob('job_1')).toMatchObject({
      state: 'synced',
      terminalReason: 'ocr_succeeded',
    });
    expect(timeline.items).toEqual([
      expect.objectContaining({
        sourceApp: 'Code',
        snippet: 'Retention review',
        title: 'Retention review',
      }),
    ]);
    expect(search.items).toEqual([
      expect.objectContaining({
        snippet: 'Visible retention graph and roadmap notes',
        sourceApp: 'Code',
        title: 'Retention Review',
      }),
    ]);
    expect(serialized).not.toContain('summary-only');
    expect(harness.captureSnapshot().searchDocuments).toHaveLength(1);
  });

  it('rejects missing privacyDecision.decidedAt before transport and at the server HTTP route', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const harness = await startServerHttpHarness({
      ocrRunner: fixedOcrRunner('Contract guard OCR'),
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
    const store = createInMemoryOperationalStore();
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

  it('keeps provider_unavailable job-level failures retryable without exposing provider text to desktop state or search', async () => {
    const bytes = new Uint8Array([9, 10, 11, 12]);
    const harness = await startServerHttpHarness({
      ocrRunner: failedOcrRunner('provider_unavailable', leakedProviderMessage, true),
    });
    const user = await harness.bootstrapUser('desktop-provider-unavailable@example.test');
    const store = createInMemoryOperationalStore();
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
        code: 'provider_unavailable',
        message: 'Provider is unavailable.',
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

  it('cancels local and server jobs as terminal and observes temporary cleanup over HTTP', async () => {
    const bytes = new Uint8Array([13, 14, 15, 16]);
    const harness = await startServerHttpHarness({ ocrRunner: deferredOcrRunner() });
    const user = await harness.bootstrapUser('desktop-cancel@example.test');
    const store = createInMemoryOperationalStore();
    await seedPendingCapture(store, user.workspaceId, bytes);
    const client = createHttpClient(harness.endpoint, user.accessToken);
    const scheduler = createScheduler(store, client, user.workspaceId, bytes);

    const result = await scheduler.runOnce();
    const queuedJob = await store.getOutboxJob('job_1');
    expect(result.status).toBe('retry_wait');
    expect(queuedJob?.serverOcrJobId).toBeString();

    const cancel = await scheduler.cancel('job_1', 'user_cancelled');
    const terminalJob = await store.getOutboxJob('job_1');
    const serverJob = await client.pollOcrJob(user.workspaceId, queuedJob?.serverOcrJobId ?? '');

    expect(cancel).toEqual({ cancelled: true, jobId: 'job_1' });
    expect(terminalJob).toMatchObject({
      state: 'cancelled',
      terminalReason: 'user_cancelled',
    });
    expect(serverJob.job.status).toBe('cancelled');
    expect(harness.captureSnapshot().ocrResults).toHaveLength(0);
    expect(harness.captureSnapshot().searchDocuments).toHaveLength(0);
    expect(
      harness
        .captureSnapshot()
        .assetLocations.some(
          (location) =>
            location.kind === 'server_temporary' && location.cleanupStatus === 'cleaned',
        ),
    ).toBe(true);
  });

  it('does not upload bytes or create OCR jobs for block_ocr over real HTTP', async () => {
    const bytes = new Uint8Array([17, 18, 19, 20]);
    const harness = await startServerHttpHarness({
      ocrRunner: fixedOcrRunner('This OCR must not run'),
    });
    const user = await harness.bootstrapUser('desktop-block-ocr@example.test');
    const store = createInMemoryOperationalStore();
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
    expect(harness.captureSnapshot().temporaryUploads).toHaveLength(0);
    expect(harness.captureSnapshot().ocrJobs).toHaveLength(0);
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
    endpoint,
    tokenStore: createInMemoryTokenStore({
      accessToken,
      refreshToken: 'desktop-refresh-token',
    }),
    transport: fetchTransport,
  });
}

function createScheduler(
  store: ReturnType<typeof createInMemoryOperationalStore>,
  api: ServerApiClient,
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
    retryDelayMs: 60_000,
    store,
    workspace: {
      getActiveWorkspaceId: async () => workspaceId,
    },
  });
}

async function seedPendingCapture(
  store: ReturnType<typeof createInMemoryOperationalStore>,
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

function createAsset(workspaceId: string, bytes: Uint8Array): AssetCacheRef {
  return {
    assetRefId: 'asset_ref_1',
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
  captureSnapshot(): CaptureSnapshot;
  stop(): void;
};

type CaptureSnapshot = {
  assetLocations: Array<{ kind: string; cleanupStatus?: string }>;
  captures: unknown[];
  ocrJobs: unknown[];
  ocrResults: unknown[];
  searchDocuments: unknown[];
  temporaryUploads: unknown[];
};

type ServerHarnessOptions = {
  ocrRunner?: OcrRunner;
  useAppDefaultOcrRunner?: boolean;
};

type OcrRunner = {
  run(input: unknown): Promise<unknown>;
};

async function startServerHttpHarness(options: ServerHarnessOptions): Promise<ServerHttpHarness> {
  const modules = await loadServerModules();
  const serverTempAssetDir = mkdtempSync(join(tmpdir(), 'recapsy-desktop-http-assets-'));
  let server: ReturnType<typeof Bun.serve> | undefined;

  try {
    const accountManagementRepository = new modules.InMemoryAccountManagementRepository();
    const captureOcrSearchRepository = new modules.InMemoryCaptureOcrSearchRepository();
    const app = modules.createApp({
      accountManagementRepository,
      captureOcrSearchRepository,
      config: {
        ADMIN_BOOTSTRAP_TOKEN: adminToken,
        DATABASE_URL: 'postgresql://test',
        EMBEDDING_PROVIDER: 'stub',
        LOG_LEVEL: 'error',
        NODE_ENV: options.useAppDefaultOcrRunner ? 'production' : 'test',
        OCR_MAX_INPUT_BYTES: 1024 * 1024,
        OBJECT_STORAGE_PREFIX: 'recapsy/test',
        PORT: 0,
        PROVIDER_ENCRYPTION_SECRET: providerSecret,
        SERVER_TEMP_ASSET_DIR: serverTempAssetDir,
        SESSION_SECRET: sessionSecret,
        TEMP_UPLOAD_DIR: serverTempAssetDir,
      },
      db: {},
      logger: {
        debug() {},
        error() {},
        info() {},
        warn() {},
      },
      ...(options.useAppDefaultOcrRunner ? {} : { ocrRunner: options.ocrRunner }),
    });
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
        return captureOcrSearchRepository.snapshot() as CaptureSnapshot;
      },
      stop() {
        server?.stop(true);
        server = undefined;
        rmSync(serverTempAssetDir, { force: true, recursive: true });
      },
    };
    activeHarnesses.push(harness);
    return harness;
  } catch (error) {
    server?.stop(true);
    rmSync(serverTempAssetDir, { force: true, recursive: true });
    throw error;
  }
}

async function loadServerModules() {
  const appModule = await import(new URL('../../server/src/app.ts', import.meta.url).href);
  const accountRepositoryModule = await import(
    new URL('../../server/src/account-management/repositories/memory.ts', import.meta.url).href
  );
  const captureRepositoryModule = await import(
    new URL('../../server/src/capture-ocr-search/repositories/memory.ts', import.meta.url).href
  );
  const modelsModule = await import(
    new URL('../../server/src/capture-ocr-search/models.ts', import.meta.url).href
  );

  return {
    InMemoryAccountManagementRepository:
      accountRepositoryModule.InMemoryAccountManagementRepository,
    InMemoryCaptureOcrSearchRepository: captureRepositoryModule.InMemoryCaptureOcrSearchRepository,
    createApp: appModule.createApp,
    safeOcrError: modelsModule.safeOcrError,
  };
}

function fixedOcrRunner(text: string, activitySummary = 'Processed screenshot OCR'): OcrRunner {
  return {
    async run() {
      return {
        activitySummary,
        blocks: [{ kind: 'line', order: 0, text }],
        entities: [],
        status: 'succeeded',
        text,
      };
    },
  };
}

function failedOcrRunner(code: string, messageSafe: string, retryable: boolean): OcrRunner {
  return {
    async run() {
      const modules = await loadServerModules();
      return {
        error: modules.safeOcrError(code, messageSafe, retryable),
        status: 'failed',
      };
    },
  };
}

function deferredOcrRunner(): OcrRunner {
  return {
    async run() {
      return { status: 'deferred' };
    },
  };
}

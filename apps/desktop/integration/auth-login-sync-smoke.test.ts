import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import type { createTestHttpApp } from '../../server/src/__tests__/app-harness';
import type { InMemoryAccountManagementRepository } from '../../server/src/account-management/repositories/memory';
import type { CaptureRepositorySnapshot } from '../../server/src/capture/models';
import type { InMemoryCaptureRepository } from '../../server/src/capture/repositories/memory';
import type { Logger } from '../../server/src/shared/logger';
import { createAuthClient } from '../src/auth/client';
import { createInMemoryTokenStore } from '../src/auth/tokens';
import { createServerApiClient } from '../src/server/client';
import type { ServerApiTransport } from '../src/server/types';
import { createMemoryStore } from '../src/storage';
import type { AssetCacheRef, OperationalStoreRepository } from '../src/storage';
import { createSyncJobExecutor } from '../src/sync/job';
import { createSyncScheduler } from '../src/sync/scheduler';
import type { SyncAssetReader } from '../src/sync/types';

/**
 * End-to-end smoke test for the real login -> sync loop path this task adds:
 * bootstrap a real user against a real (in-process) server HTTP app, log in
 * through the real `createAuthClient()` (hitting the real `/v1/auth/login`
 * and `/v1/auth/session` routes, not a mock), then feed the resulting real
 * token + workspace id into `createServerApiClient` + `createSyncScheduler`
 * exactly as `main/runtime.ts` does. This intentionally
 * reuses the harness pattern from `server-http-smoke.test.ts`
 * (`Bun.serve()` + in-memory repositories, no real Postgres) rather than a
 * bespoke mock server.
 *
 * There is no real Swift helper yet, so there are no real asset bytes to
 * upload. That is asserted here as an honest `blocked` outbox state (via
 * the same `local_asset_unreadable` fail-closed shape
 * `main/runtime.ts`'s `failClosedReadAssetBytes` uses), not
 * faked as `synced`.
 */

const now = '2026-07-06T00:00:00.000Z';
const adminToken = 'test-admin-bootstrap-token';
const sessionSecret = 'test-session-secret-with-enough-entropy';
const providerSecret = 'test-provider-secret-with-enough-entropy';
const password = 'correct horse battery staple';

const activeHarnesses: ServerHttpHarness[] = [];

afterEach(() => {
  for (const harness of activeHarnesses.splice(0)) {
    harness.stop();
  }
});

describe('real login through to the sync loop over real HTTP', () => {
  it('logs in through /v1/auth/login, validates the session through /v1/auth/session, and runs the sync scheduler against real workspace/token values', async () => {
    const harness = await startServerHttpHarness();
    const email = 'desktop-auth-smoke@example.test';
    const registered = await harness.registerUser(email);

    const tokenStore = createInMemoryTokenStore();
    const authClient = createAuthClient({
      endpoint: harness.endpoint,
      tokenStore,
      transport: fetchTransport,
    });

    // 1. Real login: hits the real `/v1/auth/login` route (the same route
    // `service.login` in `apps/server/src/account-management/service.ts`
    // implements), not a stand-in.
    const loginResult = await authClient.login({ email, password });

    expect(loginResult.workspaceId).toBe(registered.workspaceId);
    const storedTokens = await tokenStore.getTokens();
    expect(storedTokens?.accessToken).toBeString();
    expect(storedTokens?.accessToken).not.toBe(registered.accessToken); // a genuinely new token, not the register response's token

    // 2. Real session validation: `getActiveSession()` re-confirms the just
    // stored token against the real `/v1/auth/session` route (this is the
    // check `resolveWorkspaceId` in `main/runtime.ts` runs on
    // every startup before deciding whether to skip the login window).
    const activeSession = await authClient.getActiveSession();
    expect(activeSession).toEqual({ workspaceId: registered.workspaceId });

    // 3. A cleared/garbage token must fail closed to "no session", not throw
    // or silently invent a workspace id.
    await tokenStore.setTokens({ accessToken: 'not-a-real-token' });
    expect(await authClient.getActiveSession()).toBeNull();
    expect(await tokenStore.getTokens()).toBeNull(); // 401 clears the stale token

    // Re-login for the sync portion below (the 401 probe above cleared tokenStore).
    await authClient.login({ email, password });

    // 4. Real server API client + real sync scheduler, using the workspace
    // id and token that came out of the real login above — the same
    // construction `main/runtime.ts` performs after
    // `resolveWorkspaceId()` resolves.
    const api = createServerApiClient({
      accessTokenProvider: {
        getAccessToken: async () => (await tokenStore.getTokens())?.accessToken ?? null,
      },
      endpoint: harness.endpoint,
      transport: fetchTransport,
    });
    const store = createMemoryStore();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await seedPendingCapture(store, registered.workspaceId, bytes);

    const clock = { now: () => now };
    const workspace = { getActiveWorkspaceId: async () => registered.workspaceId };
    const executeJob = createSyncJobExecutor({
      api,
      clock,
      maxAttempts: 3,
      readAssetBytes: failClosedReadAssetBytes,
      retryBackoff: { baseMs: 60_000, factor: 2, jitterRatio: 0, maxMs: 300_000 },
      store,
      workspace,
    });
    const scheduler = createSyncScheduler({
      clock,
      executeJob,
      maxAttempts: 3,
      store,
      workspace,
    });

    // 5. First run: real ingestCapture over HTTP succeeds, but there are no
    // real asset bytes yet (no Swift helper in this repo), so this must
    // fail closed to `blocked` — never a fabricated `synced`.
    const firstRun = await scheduler.runOnce();
    expect(firstRun).toEqual({ jobId: 'job_1', processed: 1, status: 'blocked' });

    const job = await store.getOutboxJob('job_1');
    expect(job).toMatchObject({
      lastSafeError: {
        code: 'local_asset_unreadable',
        message: 'Local asset is unreadable.',
        retryable: false,
      },
      state: 'blocked',
      terminalReason: 'local_asset_unreadable',
    });

    // 6. Second run: the job is now terminal, so there is nothing left to
    // claim — the scheduler must report `idle`, not re-process it.
    const secondRun = await scheduler.runOnce();
    expect(secondRun).toEqual({ processed: 0, status: 'idle' });

    // Capture ingest completed, but the unreadable local asset stopped the
    // thin-proxy flow before OCR and result submission created any records.
    const captureSnapshot = harness.captureSnapshot();
    expect(captureSnapshot.captures).toHaveLength(1);
    expect(captureSnapshot.ocrJobs).toHaveLength(0);
    expect(captureSnapshot.ocrResults).toHaveLength(0);
    expect(captureSnapshot.searchDocuments).toHaveLength(0);
  });

  it('keeps the last confirmed workspace id cached in the token store when the real server becomes unreachable', async () => {
    // Real-world foundation for `resolveWorkspaceId`'s offline degradation
    // (`main/runtime.ts`): a stored token whose session cannot
    // be re-verified because the server is down (not a confirmed 401) must
    // still carry the last real, server-confirmed workspace id, so the main
    // process can keep running against it instead of blocking behind a
    // login window the user cannot complete offline.
    const harness = await startServerHttpHarness();
    const email = 'desktop-auth-smoke-offline-degrade@example.test';
    const registered = await harness.registerUser(email);

    const tokenStore = createInMemoryTokenStore();
    const authClient = createAuthClient({
      endpoint: harness.endpoint,
      tokenStore,
      transport: fetchTransport,
    });

    const loginResult = await authClient.login({ email, password });
    expect(loginResult.workspaceId).toBe(registered.workspaceId);
    expect((await tokenStore.getTokens())?.workspaceId).toBe(registered.workspaceId);

    // Simulate the server becoming unreachable (not a 401 — a real
    // connection failure) by tearing down the in-process HTTP server this
    // client's `endpoint` points at.
    harness.stop();

    await expect(authClient.getActiveSession()).rejects.toMatchObject({
      code: 'offline',
      retryable: true,
    });

    // The cached workspace id from the earlier real login must survive this
    // failed check untouched — this is exactly what lets
    // `resolveWorkspaceId` degrade to it instead of prompting login.
    const tokensAfterOutage = await tokenStore.getTokens();
    expect(tokensAfterOutage?.workspaceId).toBe(registered.workspaceId);
    expect(tokensAfterOutage?.accessToken).toBeString();
  });

  it('rejects a login with the wrong password against the real server without storing any token', async () => {
    const harness = await startServerHttpHarness();
    const email = 'desktop-auth-smoke-wrong-password@example.test';
    await harness.registerUser(email);

    const tokenStore = createInMemoryTokenStore();
    const authClient = createAuthClient({
      endpoint: harness.endpoint,
      tokenStore,
      transport: fetchTransport,
    });

    await expect(
      authClient.login({ email, password: 'not the right password' }),
    ).rejects.toMatchObject({
      code: 'invalid_credentials',
      retryable: false,
    });
    expect(await tokenStore.getTokens()).toBeNull();
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

/**
 * Mirrors `main/runtime.ts`'s `failClosedReadAssetBytes`
 * exactly (same safe-error shape `sync/job.ts` already has dedicated
 * handling for), rather than importing it: that constant is not exported
 * (deliberately private to the runtime wiring module), and duplicating a
 * five-line fail-closed stub here keeps this integration test independent
 * of that module's internals.
 */
const failClosedReadAssetBytes: SyncAssetReader = async () => {
  throw Object.assign(new Error('no real asset bytes in this test'), {
    code: 'local_asset_unreadable',
    retryable: false,
    safeMessage: 'Local asset is unreadable.',
  });
};

async function seedPendingCapture(
  store: OperationalStoreRepository,
  workspaceId: string,
  bytes: Uint8Array,
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
      contextFingerprint: 'sha256:context-fingerprint-auth-login-smoke',
      documentPathCandidate: {
        displayName: 'Retention Review.md',
        hash: 'sha256:document-hash-auth-login-smoke',
        kind: 'safe',
      },
      localEventId: 'local-event-auth-login-smoke',
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
    },
    createdAt: now,
    deviceId: 'device_1',
    id: 'job_1',
    idempotencyKey: 'auth-login-smoke-idempotency-key',
    payloadHash: sha256Hex(new TextEncoder().encode('auth-login-smoke-payload')),
    workspaceId,
  });
  expect(created.ok).toBe(true);
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
  registerUser(email: string): Promise<{ accessToken: string; workspaceId: string }>;
  captureSnapshot(): CaptureRepositorySnapshot;
  stop(): void;
};

async function startServerHttpHarness(): Promise<ServerHttpHarness> {
  const modules = await loadServerModules();
  let server: ReturnType<typeof Bun.serve> | undefined;

  try {
    const accountManagementRepository = new modules.InMemoryAccountManagementRepository();
    const captureRepository = new modules.InMemoryCaptureRepository();
    const app = modules.createTestHttpApp({
      accountManagementRepository,
      captureRepository,
      config: {
        ADMIN_BOOTSTRAP_TOKEN: adminToken,
        CORS_ALLOWED_ORIGINS: [],
        DATABASE_URL: 'postgresql://test',
        EMBEDDING_INDEXER_BATCH_SIZE: 16,
        EMBEDDING_INDEXER_INTERVAL_MS: 15_000,
        EMBEDDING_INDEXER_MAX_ATTEMPTS: 5,
        EMBEDDING_INDEXER_TIMEOUT_MS: 30_000,
        LOG_LEVEL: 'error',
        NODE_ENV: 'test',
        OCR_MAX_INPUT_BYTES: 1024 * 1024,
        OCR_PROXY_MAX_INFLIGHT_PER_USER: 2,
        PORT: 0,
        PROVIDER_ENCRYPTION_SECRET: providerSecret,
        SESSION_SECRET: sessionSecret,
      },
      logger: {
        debug() {},
        error() {},
        info() {},
        warn() {},
      } as unknown as Logger,
    }).app;
    server = Bun.serve({ fetch: app.fetch, port: 0 });
    const endpoint = server.url.toString().replace(/\/$/, '');
    const harness: ServerHttpHarness = {
      captureSnapshot() {
        return captureRepository.snapshot() as CaptureRepositorySnapshot;
      },
      endpoint,
      async registerUser(email) {
        const inviteRes = await fetch(`${endpoint}/v1/bootstrap/invites`, {
          body: JSON.stringify({
            initialQuota: { ocrJobsPerMonth: 100, searchQueriesPerMonth: 1000 },
            initialTrialDays: 14,
            note: 'Desktop auth login sync smoke',
          }),
          headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
          method: 'POST',
        });
        expect(inviteRes.status).toBe(201);
        const invite = (await inviteRes.json()) as { code: string };
        const registerRes = await fetch(`${endpoint}/v1/auth/register`, {
          body: JSON.stringify({ email, inviteCode: invite.code, password }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
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

type ServerModules = {
  InMemoryAccountManagementRepository: new () => InMemoryAccountManagementRepository;
  InMemoryCaptureRepository: new () => InMemoryCaptureRepository;
  createTestHttpApp: typeof createTestHttpApp;
};

async function loadServerModules(): Promise<ServerModules> {
  const appHarnessModule = await import(
    new URL('../../server/src/__tests__/app-harness.ts', import.meta.url).href
  );
  const accountRepositoryModule = await import(
    new URL('../../server/src/account-management/repositories/memory.ts', import.meta.url).href
  );
  const captureRepositoryModule = await import(
    new URL('../../server/src/capture/repositories/memory.ts', import.meta.url).href
  );

  return {
    InMemoryAccountManagementRepository:
      accountRepositoryModule.InMemoryAccountManagementRepository,
    InMemoryCaptureRepository: captureRepositoryModule.InMemoryCaptureRepository,
    createTestHttpApp: appHarnessModule.createTestHttpApp,
  };
}

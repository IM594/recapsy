import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { createAuthClient, createInMemoryTokenStore } from '../../src/auth/index';
import { type ServerApiTransport, createServerApiClient } from '../../src/server/index';
import { type AssetCacheRef, createMemoryStore } from '../../src/storage/index';
import {
  type SyncAssetReader,
  createSyncJobExecutor,
  createSyncWorker,
} from '../../src/sync/index';
import {
  type ServerHttpHarness,
  startServerHttpHarness as createServerHttpHarness,
  testUserPassword,
} from '../support/server-http-harness';

/**
 * End-to-end smoke test for the real login -> sync loop path this task adds:
 * bootstrap a real user against a real (in-process) server HTTP app, log in
 * through the real `createAuthClient()` (hitting the real `/v1/auth/login`
 * and `/v1/auth/session` routes, not a mock), then feed the resulting real
 * token + workspace id into `createServerApiClient` + `createSyncWorker`
 * exactly as `main/runtime.ts` does. The shared test harness starts the real
 * in-process HTTP app with in-memory repositories.
 *
 * This scenario deliberately provides no readable local asset bytes. That is
 * asserted as an honest `blocked` outbox state (via
 * the same `local_asset_unreadable` fail-closed shape
 * `main/runtime.ts`'s `failClosedReadAssetBytes` uses), not
 * faked as `synced`.
 */

const now = '2026-07-06T00:00:00.000Z';
const activeHarnesses: ServerHttpHarness[] = [];

afterEach(() => {
  for (const harness of activeHarnesses.splice(0)) {
    harness.stop();
  }
});

describe('real login through to the sync loop over real HTTP', () => {
  it('logs in through /v1/auth/login, validates the session through /v1/auth/session, and runs the sync worker against real workspace/token values', async () => {
    const harness = await startHarness();
    const email = 'desktop-auth-smoke@example.test';
    const registered = await harness.bootstrapUser(email);

    const tokenStore = createInMemoryTokenStore();
    const authClient = createAuthClient({
      endpoint: harness.endpoint,
      tokenStore,
      transport: fetchTransport,
    });

    // 1. Real login: hits the real `/v1/auth/login` route (the same route
    // `AuthService.login` in `apps/server/src/identity/auth.ts`
    // implements), not a stand-in.
    const loginResult = await authClient.login({ email, password: testUserPassword });

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
    await authClient.login({ email, password: testUserPassword });

    // 4. Real server API client + real sync worker, using the workspace
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
    const worker = createSyncWorker({
      clock,
      executeJob,
      maxAttempts: 3,
      store,
      workspace,
    });

    // 5. First run: real createCapture over HTTP succeeds, but there are no
    // real asset bytes yet (no Swift helper in this repo), so this must
    // fail closed to `blocked` — never a fabricated `synced`.
    const firstRun = await worker.runOnce();
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
    // claim — the worker must report `idle`, not re-process it.
    const secondRun = await worker.runOnce();
    expect(secondRun).toEqual({ processed: 0, status: 'idle' });

    // Capture creation completed, but the unreadable local asset stopped the
    // thin-proxy flow before OCR and result submission created any records.
    const captureSnapshot = harness.captureSnapshot();
    expect(captureSnapshot.captures).toHaveLength(1);
    expect(captureSnapshot.ocrJobs).toHaveLength(0);
    expect(captureSnapshot.ocrResults).toHaveLength(0);
    expect(captureSnapshot.searchDocuments).toHaveLength(0);
  });

  it('keeps the last confirmed workspace id cached in the token store when the real server becomes unreachable', async () => {
    // A stored token whose session cannot
    // be re-verified (`main/runtime.ts`) because the server is down must
    // still carry the last real, server-confirmed workspace id, so the main
    // process can keep running against it instead of blocking behind a
    // login window the user cannot complete offline.
    const harness = await startHarness();
    const email = 'desktop-auth-smoke-offline-degrade@example.test';
    const registered = await harness.bootstrapUser(email);

    const tokenStore = createInMemoryTokenStore();
    const authClient = createAuthClient({
      endpoint: harness.endpoint,
      tokenStore,
      transport: fetchTransport,
    });

    const loginResult = await authClient.login({ email, password: testUserPassword });
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
    const harness = await startHarness();
    const email = 'desktop-auth-smoke-wrong-password@example.test';
    await harness.bootstrapUser(email);

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

async function startHarness(): Promise<ServerHttpHarness> {
  const harness = await createServerHttpHarness();
  activeHarnesses.push(harness);
  return harness;
}

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
 * (deliberately private to the runtime wiring module), and this small
 * fail-closed implementation keeps the integration test independent
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
  store: ReturnType<typeof createMemoryStore>,
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

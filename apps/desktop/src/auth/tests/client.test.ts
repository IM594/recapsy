import { describe, expect, it } from 'bun:test';
import type { ServerApiTransport, ServerApiTransportRequest } from '../../server/index';
import { AuthClientError, createAuthClient } from '../client';
import { createInMemoryTokenStore } from '../tokens';

const endpoint = 'https://api.example.test';
const generatedAt = '2026-07-08T00:00:00.000Z';
const userId = '11111111-1111-4111-8111-111111111111';

function uuidFor(seed: string): string {
  const padded = seed.padStart(12, '0').slice(-12);
  return `22222222-2222-4222-8222-${padded}`;
}

// Full, schema-valid `AuthSessionSnapshotSchema` fixture (see
// `packages/contracts/src/schemas/auth.ts` and the schemas it composes).
// Every nested schema here is `.strict()`, so this must be exact rather than
// a loose approximation of the shape.
function loginResponseBody(workspaceId = uuidFor('1')) {
  return {
    session: {
      capabilities: {
        features: {
          auth: { enabled: true },
          captureIngestion: { enabled: true },
          cloudSync: { enabled: true },
          embeddingSearch: { enabled: true },
          hybridSearch: { enabled: true },
          invite: { enabled: true },
          manualSubscription: { enabled: true },
          providerSettings: { enabled: true },
          temporaryOcr: { enabled: true },
          textSearch: { enabled: true },
        },
        generatedAt,
        limits: {},
        providers: [],
        server: { contractVersion: 'v1', supportedPlatforms: ['macos'] },
        usage: {},
        workspaceId,
      },
      currentWorkspace: {
        createdAt: generatedAt,
        id: workspaceId,
        name: 'Acme',
        status: 'active',
        type: 'personal',
        updatedAt: generatedAt,
      },
      membership: {
        joinedAt: generatedAt,
        role: 'owner',
        status: 'active',
        userId,
        workspaceId,
      },
      providerSettings: {
        generatedAt,
        resolutionOrder: ['user', 'workspace', 'global'],
        settings: [],
        workspaceId,
      },
      session: { id: uuidFor('9'), issuedAt: generatedAt },
      subscription: {
        effectiveAt: generatedAt,
        features: {},
        limits: {},
        plan: null,
        status: 'active',
        usage: {},
        workspaceId,
      },
      user: {
        email: 'person@example.test',
        emailVerified: true,
        id: userId,
        role: 'user',
        status: 'active',
      },
    },
    tokens: {
      accessToken: 'access-token-1',
      accessTokenExpiresAt: '2026-07-08T01:00:00.000Z',
      refreshToken: 'refresh-token-1',
      refreshTokenExpiresAt: '2026-07-15T00:00:00.000Z',
      tokenType: 'bearer',
    },
  };
}

function fakeTransport(
  handler: (request: ServerApiTransportRequest) => { status: number; body?: unknown },
): { transport: ServerApiTransport; calls: ServerApiTransportRequest[] } {
  const calls: ServerApiTransportRequest[] = [];
  const transport: ServerApiTransport = async (request) => {
    calls.push(request);
    return handler(request);
  };
  return { transport, calls };
}

describe('auth client login', () => {
  it('stores tokens and returns the workspace id on a valid login response', async () => {
    const tokenStore = createInMemoryTokenStore();
    const workspaceId = uuidFor('42');
    const { transport, calls } = fakeTransport(() => ({
      body: loginResponseBody(workspaceId),
      status: 200,
    }));
    const client = createAuthClient({ endpoint, tokenStore, transport });

    const result = await client.login({ email: 'person@example.test', password: 'correct horse' });

    expect(result).toEqual({ workspaceId });
    expect(await tokenStore.getTokens()).toEqual({
      accessToken: 'access-token-1',
      expiresAt: '2026-07-08T01:00:00.000Z',
      refreshToken: 'refresh-token-1',
      workspaceId,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe('/v1/auth/login');
    expect(calls[0]?.body).toEqual({
      email: 'person@example.test',
      password: 'correct horse',
    });
  });

  it('rejects an invalid request before making any network call', async () => {
    const tokenStore = createInMemoryTokenStore();
    const { transport, calls } = fakeTransport(() => ({ body: {}, status: 200 }));
    const client = createAuthClient({ endpoint, tokenStore, transport });

    await expect(client.login({ email: 'not-an-email', password: 'x' })).rejects.toMatchObject({
      code: 'validation_failed',
      retryable: false,
    });
    expect(calls).toHaveLength(0);
    expect(await tokenStore.getTokens()).toBeNull();
  });

  it('maps a 401 auth.invalid_credentials response to invalid_credentials and stores no tokens', async () => {
    const tokenStore = createInMemoryTokenStore();
    const { transport } = fakeTransport(() => ({
      body: {
        error: {
          category: 'auth',
          code: 'auth.invalid_credentials',
          message: 'Invalid email or password.',
          requestId: 'req_1',
        },
      },
      status: 401,
    }));
    const client = createAuthClient({ endpoint, tokenStore, transport });

    await expect(
      client.login({ email: 'person@example.test', password: 'wrong-password' }),
    ).rejects.toMatchObject({
      code: 'invalid_credentials',
      retryable: false,
      status: 401,
    });
    expect(await tokenStore.getTokens()).toBeNull();
  });

  it('maps a 500 response to server_unavailable and marks it retryable', async () => {
    const tokenStore = createInMemoryTokenStore();
    const { transport } = fakeTransport(() => ({
      body: { error: { code: 'internal.unexpected' } },
      status: 500,
    }));
    const client = createAuthClient({ endpoint, tokenStore, transport });

    await expect(
      client.login({ email: 'person@example.test', password: 'correct horse' }),
    ).rejects.toMatchObject({
      code: 'server_unavailable',
      retryable: true,
    });
  });

  it('maps a transport network failure to offline', async () => {
    const tokenStore = createInMemoryTokenStore();
    const transport: ServerApiTransport = async () => {
      throw new Error('ECONNREFUSED');
    };
    const client = createAuthClient({ endpoint, tokenStore, transport });

    await expect(
      client.login({ email: 'person@example.test', password: 'correct horse' }),
    ).rejects.toMatchObject({
      code: 'offline',
      retryable: true,
    });
  });

  it('rejects a malformed success response instead of storing partial tokens', async () => {
    const tokenStore = createInMemoryTokenStore();
    const { transport } = fakeTransport(() => ({ body: { unexpected: true }, status: 200 }));
    const client = createAuthClient({ endpoint, tokenStore, transport });

    await expect(
      client.login({ email: 'person@example.test', password: 'correct horse' }),
    ).rejects.toMatchObject({ code: 'unknown', retryable: false });
    expect(await tokenStore.getTokens()).toBeNull();
  });

  it('propagates AuthClientError instances so callers can narrow on `code`', async () => {
    const tokenStore = createInMemoryTokenStore();
    const { transport } = fakeTransport(() => ({
      body: { error: { code: 'auth.invalid_credentials' } },
      status: 401,
    }));
    const client = createAuthClient({ endpoint, tokenStore, transport });

    try {
      await client.login({ email: 'person@example.test', password: 'wrong' });
      throw new Error('expected login to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthClientError);
    }
  });
});

describe('auth client getActiveSession', () => {
  it('returns null without a network call when no tokens are stored', async () => {
    const tokenStore = createInMemoryTokenStore();
    const { transport, calls } = fakeTransport(() => ({ status: 200 }));
    const client = createAuthClient({ endpoint, tokenStore, transport });

    expect(await client.getActiveSession()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('returns the workspace id for a valid stored token', async () => {
    const tokenStore = createInMemoryTokenStore({ accessToken: 'access-token-1' });
    const workspaceId = uuidFor('9');
    const { transport, calls } = fakeTransport(() => ({
      body: { session: loginResponseBody(workspaceId).session },
      status: 200,
    }));
    const client = createAuthClient({ endpoint, tokenStore, transport });

    expect(await client.getActiveSession()).toEqual({ workspaceId });
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.path).toBe('/v1/auth/session');
    expect(calls[0]?.headers.authorization).toBe('Bearer access-token-1');
  });

  it('refreshes the cached workspace id on a successful check, keeping the other token fields', async () => {
    const tokenStore = createInMemoryTokenStore({
      accessToken: 'access-token-1',
      expiresAt: '2026-07-08T01:00:00.000Z',
      refreshToken: 'refresh-token-1',
      workspaceId: uuidFor('11'),
    });
    const freshWorkspaceId = uuidFor('22');
    const { transport } = fakeTransport(() => ({
      body: { session: loginResponseBody(freshWorkspaceId).session },
      status: 200,
    }));
    const client = createAuthClient({ endpoint, tokenStore, transport });

    expect(await client.getActiveSession()).toEqual({ workspaceId: freshWorkspaceId });
    expect(await tokenStore.getTokens()).toEqual({
      accessToken: 'access-token-1',
      expiresAt: '2026-07-08T01:00:00.000Z',
      refreshToken: 'refresh-token-1',
      workspaceId: freshWorkspaceId,
    });
  });

  it('clears the token store and returns null on a 401 response', async () => {
    const tokenStore = createInMemoryTokenStore({ accessToken: 'stale-token' });
    const { transport } = fakeTransport(() => ({
      body: { error: { code: 'auth.session_expired' } },
      status: 401,
    }));
    const client = createAuthClient({ endpoint, tokenStore, transport });

    expect(await client.getActiveSession()).toBeNull();
    expect(await tokenStore.getTokens()).toBeNull();
  });

  it('throws offline for a network failure instead of silently treating it as signed out, leaving the cached workspace id untouched', async () => {
    const cachedWorkspaceId = uuidFor('cached');
    const tokenStore = createInMemoryTokenStore({
      accessToken: 'access-token-1',
      workspaceId: cachedWorkspaceId,
    });
    const transport: ServerApiTransport = async () => {
      throw new Error('network down');
    };
    const client = createAuthClient({ endpoint, tokenStore, transport });

    await expect(client.getActiveSession()).rejects.toMatchObject({
      code: 'offline',
      retryable: true,
    });
    expect(await tokenStore.getTokens()).toEqual({
      accessToken: 'access-token-1',
      workspaceId: cachedWorkspaceId,
    });
  });

  it('throws server_unavailable for a 503 without clearing tokens', async () => {
    const tokenStore = createInMemoryTokenStore({ accessToken: 'access-token-1' });
    const { transport } = fakeTransport(() => ({ body: {}, status: 503 }));
    const client = createAuthClient({ endpoint, tokenStore, transport });

    await expect(client.getActiveSession()).rejects.toMatchObject({
      code: 'server_unavailable',
      retryable: true,
    });
    expect(await tokenStore.getTokens()).not.toBeNull();
  });
});

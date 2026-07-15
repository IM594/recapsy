import { describe, expect, it } from 'bun:test';
import { createInMemoryTokenStore, createSecretTokenStore } from '../tokens';

describe('desktop auth token store', () => {
  it('keeps auth tokens behind the token store interface and clears them on sign out', async () => {
    const store = createInMemoryTokenStore();

    await store.setTokens({
      accessToken: 'access-token-secret',
      expiresAt: '2026-07-06T02:00:00.000Z',
      refreshToken: 'refresh-token-secret',
    });

    expect(await store.getTokens()).toEqual({
      accessToken: 'access-token-secret',
      expiresAt: '2026-07-06T02:00:00.000Z',
      refreshToken: 'refresh-token-secret',
    });

    await store.clearTokens();

    expect(await store.getTokens()).toBeNull();
  });

  it('keeps encrypted persistence behind the secret-store boundary', async () => {
    const writes: string[] = [];
    const adapter = createSecretTokenStore({
      account: 'user_1',
      service: 'recapsy.desktop.auth',
      secrets: {
        async delete() {
          writes.push('delete');
        },
        async read() {
          return null;
        },
        async write(_service, _account, secret) {
          writes.push(secret);
        },
      },
    });

    await adapter.setTokens({
      accessToken: 'access-token-secret',
      refreshToken: 'refresh-token-secret',
    });
    await adapter.clearTokens();

    expect(writes).toHaveLength(2);
    expect(writes[0]).toContain('access-token-secret');
    expect(writes[1]).toBe('delete');
  });
});

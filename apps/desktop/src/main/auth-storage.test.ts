import { describe, expect, it } from 'bun:test';
import type { AuthTokenSet, SecretStore, TokenStore } from '../auth/index';
import { createAuthStorage } from './auth-storage';

function memoryTokenStore(): TokenStore {
  let value: AuthTokenSet | null = null;
  return {
    async clearTokens() {
      value = null;
    },
    async getTokens() {
      return value;
    },
    async setTokens(tokens) {
      value = { ...tokens };
    },
  };
}

describe('desktop auth storage', () => {
  it('does not touch encryption or secret dependencies before first token operation', async () => {
    const calls: string[] = [];
    const secretStore: SecretStore = {
      async delete() {},
      async read() {
        return null;
      },
      async write() {},
    };
    const storage = createAuthStorage({
      account: 'default',
      createSecretStore: () => {
        calls.push('secret-store');
        return secretStore;
      },
      isEncryptionAvailable: () => {
        calls.push('encryption');
        return true;
      },
      service: 'one.recapsy.desktop.auth',
    });

    expect(calls).toEqual([]);
    await storage.getTokens();
    expect(calls).toEqual(['encryption', 'secret-store']);
  });

  it('creates encrypted storage once and preserves tokens through the secret port', async () => {
    let encryptedValue: string | null = null;
    let secretStoreCreations = 0;
    const storage = createAuthStorage({
      account: 'default',
      createSecretStore: () => {
        secretStoreCreations += 1;
        return {
          async delete() {
            encryptedValue = null;
          },
          async read() {
            return encryptedValue;
          },
          async write(_service, _account, secret) {
            encryptedValue = secret;
          },
        };
      },
      isEncryptionAvailable: () => true,
      service: 'one.recapsy.desktop.auth',
    });

    await storage.setTokens({ accessToken: 'access-secret', workspaceId: 'workspace_1' });

    expect(await storage.getTokens()).toEqual({
      accessToken: 'access-secret',
      workspaceId: 'workspace_1',
    });
    expect(secretStoreCreations).toBe(1);
  });

  it('falls back once when encryption is unavailable and emits no token data', async () => {
    const warnings: unknown[][] = [];
    let fallbackCreations = 0;
    const fallback = memoryTokenStore();
    const storage = createAuthStorage({
      account: 'default',
      createSecretStore: () => {
        throw new Error('must not create secret storage');
      },
      fallback: () => {
        fallbackCreations += 1;
        return fallback;
      },
      isEncryptionAvailable: () => false,
      onUnavailable: (...args) => warnings.push(args),
      service: 'one.recapsy.desktop.auth',
    });

    await storage.setTokens({ accessToken: 'access-secret' });
    expect(await storage.getTokens()).toEqual({ accessToken: 'access-secret' });
    expect(fallbackCreations).toBe(1);
    expect(JSON.stringify(warnings)).not.toContain('access-secret');
  });

  it('describes unavailable encryption without claiming raw tokens use a keychain', async () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);

    try {
      const storage = createAuthStorage({
        account: 'default',
        createSecretStore: () => {
          throw new Error('must not create secret storage');
        },
        isEncryptionAvailable: () => false,
        service: 'one.recapsy.desktop.auth',
      });

      await storage.getTokens();
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).toEqual([
      [
        '[recapsy-desktop] OS-backed encryption unavailable; falling back to in-memory token store (login will not persist across restarts).',
      ],
    ]);
    expect(JSON.stringify(warnings)).not.toContain('keychain');
  });
});

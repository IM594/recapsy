import {
  type SecretStore,
  type TokenStore,
  createInMemoryTokenStore,
  createSecretTokenStore,
} from '../auth/index';

const ENCRYPTION_UNAVAILABLE_WARNING =
  '[recapsy-desktop] OS-backed encryption unavailable; falling back to in-memory token store (login will not persist across restarts).';

export type AuthStorageOptions = {
  service: string;
  account: string;
  isEncryptionAvailable(): boolean;
  createSecretStore(): SecretStore;
  fallback?(): TokenStore;
  onUnavailable?(): void;
};

export function createAuthStorage(options: AuthStorageOptions): TokenStore {
  let tokenStore: TokenStore | undefined;

  function resolve(): TokenStore {
    if (tokenStore) {
      return tokenStore;
    }

    if (options.isEncryptionAvailable()) {
      tokenStore = createSecretTokenStore({
        account: options.account,
        secrets: options.createSecretStore(),
        service: options.service,
      });
      return tokenStore;
    }

    (options.onUnavailable ?? defaultUnavailableWarning)();
    tokenStore = (options.fallback ?? createInMemoryTokenStore)();
    return tokenStore;
  }

  return {
    clearTokens: () => resolve().clearTokens(),
    getTokens: () => resolve().getTokens(),
    setTokens: (tokens) => resolve().setTokens(tokens),
  };
}

function defaultUnavailableWarning(): void {
  console.warn(ENCRYPTION_UNAVAILABLE_WARNING);
}

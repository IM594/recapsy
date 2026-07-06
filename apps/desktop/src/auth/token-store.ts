export type AuthTokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
};

export type TokenStore = {
  getTokens(): Promise<AuthTokenSet | null>;
  setTokens(tokens: AuthTokenSet): Promise<void>;
  clearTokens(): Promise<void>;
};

export type KeychainSecretStore = {
  read(service: string, account: string): Promise<string | null>;
  write(service: string, account: string, secret: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
};

export type MacOsKeychainTokenStoreOptions = {
  service: string;
  account: string;
  secrets: KeychainSecretStore;
};

export function createInMemoryTokenStore(initialTokens: AuthTokenSet | null = null): TokenStore {
  let tokens = initialTokens ? cloneTokens(initialTokens) : null;

  return {
    async clearTokens() {
      tokens = null;
    },
    async getTokens() {
      return tokens ? cloneTokens(tokens) : null;
    },
    async setTokens(nextTokens) {
      tokens = cloneTokens(nextTokens);
    },
  };
}

export function createMacOsKeychainTokenStore(options: MacOsKeychainTokenStoreOptions): TokenStore {
  return {
    async clearTokens() {
      await options.secrets.delete(options.service, options.account);
    },
    async getTokens() {
      const secret = await options.secrets.read(options.service, options.account);

      if (!secret) {
        return null;
      }

      return parseStoredTokens(secret);
    },
    async setTokens(tokens) {
      await options.secrets.write(options.service, options.account, JSON.stringify(tokens));
    },
  };
}

function cloneTokens(tokens: AuthTokenSet): AuthTokenSet {
  return { ...tokens };
}

function parseStoredTokens(secret: string): AuthTokenSet | null {
  try {
    const value = JSON.parse(secret) as Partial<AuthTokenSet>;

    if (typeof value.accessToken !== 'string' || value.accessToken.length === 0) {
      return null;
    }

    return {
      accessToken: value.accessToken,
      ...(typeof value.expiresAt === 'string' ? { expiresAt: value.expiresAt } : {}),
      ...(typeof value.refreshToken === 'string' ? { refreshToken: value.refreshToken } : {}),
    };
  } catch {
    return null;
  }
}

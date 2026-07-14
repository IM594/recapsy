export type AuthTokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  /**
   * The workspace id from the most recent real, server-confirmed session
   * (a successful `login()` or `getActiveSession()` call in
   * `auth/client.ts`). Stored alongside the tokens — not derived
   * separately — because its lifecycle is the same as the tokens': it is
   * only ever set together with them, and must be cleared together with
   * them on sign-out. Consumers (see `createSessionStartup` in
   * `auth/session.ts`) use this as a degraded fallback when
   * the session cannot be re-verified because the network/server is
   * unavailable — never as a substitute for a confirmed 401/expired
   * session, which always forces a fresh login.
   */
  workspaceId?: string;
};

export type TokenStore = {
  getTokens(): Promise<AuthTokenSet | null>;
  setTokens(tokens: AuthTokenSet): Promise<void>;
  clearTokens(): Promise<void>;
};

export type SecretStore = {
  read(service: string, account: string): Promise<string | null>;
  write(service: string, account: string, secret: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
};

export type SecretTokenStoreOptions = {
  service: string;
  account: string;
  secrets: SecretStore;
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

export function createSecretTokenStore(options: SecretTokenStoreOptions): TokenStore {
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
      ...(typeof value.workspaceId === 'string' ? { workspaceId: value.workspaceId } : {}),
    };
  } catch {
    return null;
  }
}

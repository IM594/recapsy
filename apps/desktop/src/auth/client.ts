import {
  AuthLoginRequestSchema,
  AuthLoginResponseSchema,
  AuthRefreshResponseSchema,
  AuthSessionResponseSchema,
} from '@recapsy/contracts';
import { redactLogPayload } from '../logging/redaction';
import type {
  ServerApiTransport,
  ServerApiTransportRequest,
  ServerApiTransportResponse,
} from '../server/index';
import type { AuthTokenSet, TokenStore } from './tokens';

/**
 * Error codes this client can surface. Deliberately narrower than
 * `ServerApiErrorCode` (see `server/client.ts`): login only needs to
 * distinguish "credentials were wrong", "request was malformed",
 * "network/server problem" and "everything else", so renderer/main callers
 * do not have to reason about OCR- or capture-specific codes here.
 */
export type AuthClientErrorCode =
  | 'invalid_credentials'
  | 'unauthenticated'
  | 'validation_failed'
  | 'offline'
  | 'server_unavailable'
  | 'unknown';

export type AuthClientErrorShape = {
  code: AuthClientErrorCode;
  safeMessage: string;
  retryable: boolean;
  status?: number;
  details?: Record<string, unknown>;
};

export class AuthClientError extends Error implements AuthClientErrorShape {
  readonly code: AuthClientErrorCode;
  readonly retryable: boolean;
  readonly safeMessage: string;
  readonly status?: number;
  readonly details?: Record<string, unknown>;

  constructor(input: AuthClientErrorShape) {
    super(input.safeMessage);
    this.name = 'AuthClientError';
    this.code = input.code;
    this.retryable = input.retryable;
    this.safeMessage = input.safeMessage;
    this.status = input.status;
    this.details = input.details
      ? (redactLogPayload(input.details) as Record<string, unknown>)
      : undefined;
  }
}

export type AuthLoginInput = {
  email: string;
  password: string;
};

export type AuthLoginResult = {
  workspaceId: string;
};

export type AuthActiveSession = {
  workspaceId: string;
};

export type AuthClientOptions = {
  endpoint: string;
  tokenStore: TokenStore;
  /**
   * Reuses `ServerApiTransport`'s shape (see `server/types.ts`) so the
   * real Electron entry point can share one `fetch`-backed transport
   * implementation across this client and `createServerApiClient`, and so
   * tests can share the same fake-transport pattern already used in
   * `server/tests/client.test.ts` / `tests/integration/server-http.test.ts`.
   */
  transport: ServerApiTransport;
  /**
   * Wall clock used to decide whether a stored access token still needs a
   * silent refresh before sync / acceptance callers consume it. Defaults to
   * `Date`.
   */
  now?: () => Date;
};

export type AuthClient = {
  /**
   * Calls the real `/v1/auth/login` route, stores the returned tokens
   * (including the workspace id from `session.currentWorkspace`, see
   * `AuthTokenSet.workspaceId`) in `tokenStore`, and returns that workspace
   * id. Throws `AuthClientError` on any failure; never partially stores
   * tokens on a failed or malformed response.
   */
  login(input: AuthLoginInput): Promise<AuthLoginResult>;
  /**
   * Exchanges the stored refresh token via `POST /v1/auth/refresh` and writes
   * the new token pair back. Concurrent callers share one in-flight refresh
   * (single-flight). Unauthenticated / missing refresh clears the store;
   * retryable network/server failures leave tokens untouched.
   */
  refresh(): Promise<AuthLoginResult>;
  /**
   * Validates whatever tokens are currently in `tokenStore` against the real
   * `/v1/auth/session` route. When access returns 401 and a refresh token is
   * still stored, silently refreshes once and re-checks the session. Returns
   * `null` (and clears the token store) only when there is no recoverable
   * session — missing tokens, no refresh after access 401, or refresh itself
   * rejected as unauthenticated. On success, also refreshes the stored
   * `AuthTokenSet.workspaceId` to the value this call just confirmed, so it
   * stays the most recently *confirmed* workspace id for later offline
   * degradation (see `resolveWorkspaceId` in `main/runtime.ts`). Throws
   * `AuthClientError` for network/server failures, which the caller treats
   * the same as "cannot confirm a session right now" — not the same as a
   * confirmed-invalid session.
   */
  getActiveSession(): Promise<AuthActiveSession | null>;
  /**
   * Returns a usable access token for sync / acceptance. When the stored
   * access token is past `expiresAt` and a refresh token exists, performs a
   * single-flight silent refresh first. Returns `null` when there is no
   * token, or when a required refresh fails as unauthenticated (tokens are
   * cleared in that case). Retryable refresh failures rethrow.
   */
  getAccessToken(): Promise<string | null>;
};

export function createAuthClient(options: AuthClientOptions): AuthClient {
  const endpoint = normalizeEndpoint(options.endpoint);
  const now = options.now ?? (() => new Date());
  let refreshInFlight: Promise<AuthLoginResult> | null = null;

  async function storeTokenPair(body: {
    tokens: {
      accessToken: string;
      accessTokenExpiresAt: string;
      refreshToken: string;
    };
    session: { currentWorkspace: { id: string } };
  }): Promise<AuthLoginResult> {
    const workspaceId = body.session.currentWorkspace.id;
    await options.tokenStore.setTokens({
      accessToken: body.tokens.accessToken,
      expiresAt: body.tokens.accessTokenExpiresAt,
      refreshToken: body.tokens.refreshToken,
      workspaceId,
    });
    return { workspaceId };
  }

  async function performRefresh(tokens: AuthTokenSet): Promise<AuthLoginResult> {
    const refreshToken = tokens.refreshToken;

    if (!refreshToken) {
      await options.tokenStore.clearTokens();
      throw new AuthClientError({
        code: 'unauthenticated',
        retryable: false,
        safeMessage: '会话已失效。',
      });
    }

    let response: ServerApiTransportResponse;
    try {
      response = await options.transport({
        body: { refreshToken },
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        path: '/v1/auth/refresh',
        query: {},
        url: new URL('/v1/auth/refresh', endpoint),
      });
    } catch {
      throw new AuthClientError({
        code: 'offline',
        retryable: true,
        safeMessage: '网络不可用或已离线。',
      });
    }

    if (response.status >= 400) {
      const error = toAuthClientError(response);
      if (error.code === 'unauthenticated') {
        await options.tokenStore.clearTokens();
      }
      throw error;
    }

    const parsed = AuthRefreshResponseSchema.safeParse(response.body);

    if (!parsed.success) {
      throw new AuthClientError({
        code: 'unknown',
        retryable: false,
        safeMessage: '刷新会话响应格式无效。',
      });
    }

    return storeTokenPair(parsed.data);
  }

  async function refresh(): Promise<AuthLoginResult> {
    if (refreshInFlight) {
      return refreshInFlight;
    }

    refreshInFlight = (async () => {
      const tokens = await options.tokenStore.getTokens();

      if (!tokens) {
        throw new AuthClientError({
          code: 'unauthenticated',
          retryable: false,
          safeMessage: '会话已失效。',
        });
      }

      return performRefresh(tokens);
    })().finally(() => {
      refreshInFlight = null;
    });

    return refreshInFlight;
  }

  async function readSession(
    accessToken: string,
  ): Promise<
    | { kind: 'ok'; workspaceId: string }
    | { kind: 'unauthenticated' }
    | { kind: 'error'; error: AuthClientError }
  > {
    let response: ServerApiTransportResponse;
    try {
      response = await options.transport({
        headers: { authorization: `Bearer ${accessToken}` },
        method: 'GET',
        path: '/v1/auth/session',
        query: {},
        url: new URL('/v1/auth/session', endpoint),
      });
    } catch {
      return {
        kind: 'error',
        error: new AuthClientError({
          code: 'offline',
          retryable: true,
          safeMessage: '网络不可用或已离线。',
        }),
      };
    }

    if (response.status === 401) {
      return { kind: 'unauthenticated' };
    }

    if (response.status >= 400) {
      return { kind: 'error', error: toAuthClientError(response) };
    }

    const parsed = AuthSessionResponseSchema.safeParse(response.body);

    if (!parsed.success) {
      return {
        kind: 'error',
        error: new AuthClientError({
          code: 'unknown',
          retryable: false,
          safeMessage: '会话响应格式无效。',
        }),
      };
    }

    return { kind: 'ok', workspaceId: parsed.data.session.currentWorkspace.id };
  }

  return {
    async getAccessToken() {
      const tokens = await options.tokenStore.getTokens();

      if (!tokens) {
        return null;
      }

      if (!accessTokenNeedsRefresh(tokens, now())) {
        return tokens.accessToken;
      }

      try {
        await refresh();
      } catch (error) {
        if (error instanceof AuthClientError && error.code === 'unauthenticated') {
          return null;
        }
        throw error;
      }

      return (await options.tokenStore.getTokens())?.accessToken ?? null;
    },
    async getActiveSession() {
      const tokens = await options.tokenStore.getTokens();

      if (!tokens) {
        return null;
      }

      const first = await readSession(tokens.accessToken);

      if (first.kind === 'error') {
        throw first.error;
      }

      if (first.kind === 'unauthenticated') {
        if (!tokens.refreshToken) {
          await options.tokenStore.clearTokens();
          return null;
        }

        try {
          await refresh();
        } catch (error) {
          if (error instanceof AuthClientError && error.code === 'unauthenticated') {
            return null;
          }
          throw error;
        }

        const refreshed = await options.tokenStore.getTokens();

        if (!refreshed) {
          return null;
        }

        const second = await readSession(refreshed.accessToken);

        if (second.kind === 'error') {
          throw second.error;
        }

        if (second.kind === 'unauthenticated') {
          await options.tokenStore.clearTokens();
          return null;
        }

        await options.tokenStore.setTokens({
          ...refreshed,
          workspaceId: second.workspaceId,
        });
        return { workspaceId: second.workspaceId };
      }

      // `/v1/auth/session` does not re-issue tokens (see
      // `AuthSessionResponseSchema`), so the existing `tokens` fetched above
      // are carried through unchanged; only `workspaceId` is refreshed to
      // the value this call just confirmed with the real server. Callers
      // (see `resolveWorkspaceId` in `main/runtime.ts`) rely on
      // this being kept current so an offline degradation later falls back
      // to the most recently *confirmed* workspace id, not a stale one.
      await options.tokenStore.setTokens({ ...tokens, workspaceId: first.workspaceId });

      return { workspaceId: first.workspaceId };
    },
    async login(input) {
      const parsedRequest = AuthLoginRequestSchema.safeParse(input);

      if (!parsedRequest.success) {
        throw new AuthClientError({
          code: 'validation_failed',
          details: redactLogPayload(parsedRequest.error.flatten()),
          retryable: false,
          safeMessage: '邮箱或密码无效。',
        });
      }

      let response: ServerApiTransportResponse;
      try {
        response = await options.transport({
          body: parsedRequest.data,
          headers: { 'content-type': 'application/json' },
          method: 'POST',
          path: '/v1/auth/login',
          query: {},
          url: new URL('/v1/auth/login', endpoint),
        });
      } catch {
        throw new AuthClientError({
          code: 'offline',
          retryable: true,
          safeMessage: '网络不可用或已离线。',
        });
      }

      if (response.status >= 400) {
        throw toAuthClientError(response);
      }

      const parsed = AuthLoginResponseSchema.safeParse(response.body);

      if (!parsed.success) {
        throw new AuthClientError({
          code: 'unknown',
          retryable: false,
          safeMessage: '登录响应格式无效。',
        });
      }

      return storeTokenPair(parsed.data);
    },
    refresh,
  };
}

function accessTokenNeedsRefresh(tokens: AuthTokenSet, now: Date): boolean {
  if (!tokens.refreshToken || !tokens.expiresAt) {
    return false;
  }

  const expiresAtMs = Date.parse(tokens.expiresAt);

  if (Number.isNaN(expiresAtMs)) {
    return false;
  }

  return expiresAtMs <= now.getTime();
}

function normalizeEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  url.search = '';
  return url;
}

function toAuthClientError(response: ServerApiTransportResponse): AuthClientError {
  const payload = isRecord(response.body) ? response.body : {};
  const apiError = isRecord(payload.error) ? payload.error : {};
  const rawCode = typeof apiError.code === 'string' ? apiError.code : undefined;
  const code = mapErrorCode(rawCode, response.status);

  return new AuthClientError({
    code,
    retryable: code === 'offline' || code === 'server_unavailable',
    safeMessage: defaultSafeMessage(code),
    status: response.status,
  });
}

function mapErrorCode(code: string | undefined, status: number): AuthClientErrorCode {
  if (code === 'auth.invalid_credentials') {
    return 'invalid_credentials';
  }

  if (
    code === 'auth.unauthenticated' ||
    code === 'auth.session_expired' ||
    code === 'auth.session_revoked'
  ) {
    return 'unauthenticated';
  }

  if (code === 'validation.invalid_input') {
    return 'validation_failed';
  }

  if (status === 401) {
    return 'unauthenticated';
  }

  if (status === 408 || status === 429 || status >= 500) {
    return 'server_unavailable';
  }

  return 'unknown';
}

function defaultSafeMessage(code: AuthClientErrorCode): string {
  if (code === 'invalid_credentials') {
    return '邮箱或密码不正确。';
  }

  if (code === 'unauthenticated') {
    return '会话已失效。';
  }

  if (code === 'validation_failed') {
    return '登录请求无效。';
  }

  if (code === 'offline') {
    return '网络不可用或已离线。';
  }

  if (code === 'server_unavailable') {
    return '服务不可用。';
  }

  return '登录失败。';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export type { ServerApiTransportRequest };

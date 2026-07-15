import {
  AuthLoginRequestSchema,
  AuthLoginResponseSchema,
  AuthSessionResponseSchema,
} from '@recapsy/contracts';
import { redactLogPayload } from '../logging/redaction';
import type {
  ServerApiTransport,
  ServerApiTransportRequest,
  ServerApiTransportResponse,
} from '../server/index';
import type { TokenStore } from './tokens';

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
   * `server/client.test.ts` / `integration/server-http-smoke.test.ts`.
   */
  transport: ServerApiTransport;
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
   * Validates whatever tokens are currently in `tokenStore` against the real
   * `/v1/auth/session` route. Returns `null` (and clears the token store)
   * when there is no token or the server reports the session as
   * unauthenticated/expired/revoked — the caller's cue to prompt login
   * again. On success, also refreshes the stored `AuthTokenSet.workspaceId`
   * to the value this call just confirmed, so it stays the most recently
   * *confirmed* workspace id for later offline degradation (see
   * `resolveWorkspaceId` in `main/runtime.ts`). Throws
   * `AuthClientError` for network/server failures, which the caller treats
   * the same as "cannot confirm a session right now" — not the same as a
   * confirmed-invalid session.
   */
  getActiveSession(): Promise<AuthActiveSession | null>;
};

export function createAuthClient(options: AuthClientOptions): AuthClient {
  const endpoint = normalizeEndpoint(options.endpoint);

  return {
    async getActiveSession() {
      const tokens = await options.tokenStore.getTokens();

      if (!tokens) {
        return null;
      }

      let response: ServerApiTransportResponse;
      try {
        response = await options.transport({
          headers: { authorization: `Bearer ${tokens.accessToken}` },
          method: 'GET',
          path: '/v1/auth/session',
          query: {},
          url: new URL('/v1/auth/session', endpoint),
        });
      } catch {
        throw new AuthClientError({
          code: 'offline',
          retryable: true,
          safeMessage: 'Network is offline or unavailable.',
        });
      }

      if (response.status === 401) {
        await options.tokenStore.clearTokens();
        return null;
      }

      if (response.status >= 400) {
        throw toAuthClientError(response);
      }

      const parsed = AuthSessionResponseSchema.safeParse(response.body);

      if (!parsed.success) {
        throw new AuthClientError({
          code: 'unknown',
          retryable: false,
          safeMessage: 'Server session response shape is invalid.',
        });
      }

      const workspaceId = parsed.data.session.currentWorkspace.id;

      // `/v1/auth/session` does not re-issue tokens (see
      // `AuthSessionResponseSchema`), so the existing `tokens` fetched above
      // are carried through unchanged; only `workspaceId` is refreshed to
      // the value this call just confirmed with the real server. Callers
      // (see `resolveWorkspaceId` in `main/runtime.ts`) rely on
      // this being kept current so an offline degradation later falls back
      // to the most recently *confirmed* workspace id, not a stale one.
      await options.tokenStore.setTokens({ ...tokens, workspaceId });

      return { workspaceId };
    },
    async login(input) {
      const parsedRequest = AuthLoginRequestSchema.safeParse(input);

      if (!parsedRequest.success) {
        throw new AuthClientError({
          code: 'validation_failed',
          details: redactLogPayload(parsedRequest.error.flatten()),
          retryable: false,
          safeMessage: 'Email or password is invalid.',
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
          safeMessage: 'Network is offline or unavailable.',
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
          safeMessage: 'Server login response shape is invalid.',
        });
      }

      await options.tokenStore.setTokens({
        accessToken: parsed.data.tokens.accessToken,
        expiresAt: parsed.data.tokens.accessTokenExpiresAt,
        refreshToken: parsed.data.tokens.refreshToken,
        workspaceId: parsed.data.session.currentWorkspace.id,
      });

      return { workspaceId: parsed.data.session.currentWorkspace.id };
    },
  };
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

  if (status === 408 || status === 429 || status >= 500) {
    return 'server_unavailable';
  }

  return 'unknown';
}

function defaultSafeMessage(code: AuthClientErrorCode): string {
  if (code === 'invalid_credentials') {
    return 'Email or password is incorrect.';
  }

  if (code === 'unauthenticated') {
    return 'Session is no longer valid.';
  }

  if (code === 'validation_failed') {
    return 'Login request is invalid.';
  }

  if (code === 'offline') {
    return 'Network is offline or unavailable.';
  }

  if (code === 'server_unavailable') {
    return 'Server is unavailable.';
  }

  return 'Login failed.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export type { ServerApiTransportRequest };

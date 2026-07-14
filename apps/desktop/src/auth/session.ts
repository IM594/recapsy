import type { AuthClient } from './client';
import type { LoginPrompter } from './login-window';
import type { TokenStore } from './tokens';

export type SessionWorkspaceResolution = {
  workspaceId: string;
  verified: boolean;
};

export type SessionStartupLogger = {
  warn(message: string): void;
};

export type SessionStartupOptions = {
  authClient: Pick<AuthClient, 'getActiveSession'>;
  loginPrompter: LoginPrompter;
  tokenStore: TokenStore;
  logger?: SessionStartupLogger;
};

export type SessionStartup = {
  resolveWorkspace(): Promise<SessionWorkspaceResolution>;
};

export function createSessionStartup(options: SessionStartupOptions): SessionStartup {
  return {
    async resolveWorkspace() {
      const tokens = await options.tokenStore.getTokens();

      if (tokens) {
        try {
          const session = await options.authClient.getActiveSession();

          if (session) {
            return { verified: true, workspaceId: session.workspaceId };
          }
        } catch {
          if (tokens.workspaceId) {
            (options.logger ?? console).warn(
              '[recapsy-desktop] could not verify the stored session at startup (network/server unavailable); continuing offline with the last confirmed workspace id',
            );
            return { verified: false, workspaceId: tokens.workspaceId };
          }
        }
      }

      const result = await options.loginPrompter.promptLogin();
      return { verified: true, workspaceId: result.workspaceId };
    },
  };
}

import type { AuthClient, AuthClientErrorCode } from './client';

/**
 * Structural surface of the single Electron `ipcMain` this module needs.
 * Kept narrow and duck-typed (same pattern as `ElectronIpcMainLike` in
 * `main/runtime.ts`) so the login orchestration logic below can
 * be exercised with `bun test` against a plain fake object, while the real
 * `electron` module's `ipcMain` singleton satisfies it as-is.
 *
 * This is intentionally a *separate*, narrower channel than the typed
 * `ipc/contracts.ts` registry: that registry models the renderer-safe API
 * surface of the fully-authenticated app window (session/workspace/capture/
 * sync/...), which does not exist yet at the point this prompt runs. The
 * login window only ever needs one method, so a dedicated `auth.login`
 * channel — registered and torn down for the lifetime of this one prompt —
 * avoids stretching that registry's DTO/session assumptions to cover a
 * pre-session bootstrap step.
 */
export type LoginIpcMainLike = {
  handle(
    channel: 'auth.login',
    listener: (event: unknown, payload: unknown) => Promise<unknown>,
  ): unknown;
  removeHandler?(channel: 'auth.login'): void;
};

/**
 * Structural surface of the Electron `BrowserWindow` this module needs.
 * `loadFile` intentionally returns `Promise<void>` (real `BrowserWindow`
 * satisfies this), and `close`/`on('closed', ...)` model the user dismissing
 * the window without submitting valid credentials.
 */
export type LoginWindowLike = {
  loadFile(filePath: string): Promise<void>;
  close(): void;
  isDestroyed(): boolean;
  on(event: 'closed', listener: () => void): unknown;
};

export type CreateLoginWindowFn = () => LoginWindowLike;

export type LoginPromptResult = {
  workspaceId: string;
};

export type LoginPrompter = {
  /**
   * Shows the login window and resolves once the user has successfully
   * authenticated. Rejects if the window is closed before that happens.
   * Never resolves with partial/unauthenticated state.
   */
  promptLogin(): Promise<LoginPromptResult>;
};

export type LoginWindowOptions = {
  ipcMain: LoginIpcMainLike;
  createWindow: CreateLoginWindowFn;
  authClient: Pick<AuthClient, 'login'>;
  /**
   * Absolute path to `login-window.html`. Injected rather than resolved from
   * `import.meta.url` here, because the real entry point
   * (`main/electron-entry.ts`) is bundled by `bun build` into a flat
   * `dist/main/electron-entry.js` — the same reason that file resolves its
   * dev helper entry from `process.cwd()` instead of a module-relative path.
   * See that file's `defaultHelperEntry` comment for the full rationale.
   */
  htmlFilePath: string;
};

/**
 * Renderer-safe error shape returned to the login form over IPC. Deliberately
 * excludes `details`/`status` (may carry validation internals not meant for
 * an unauthenticated renderer) and reduces to a fixed code + safe message,
 * matching the redaction discipline `ipc/errors.ts` applies to the main
 * app's typed IPC responses.
 */
export type LoginIpcErrorResponse = {
  ok: false;
  error: { code: AuthClientErrorCode | 'validation_failed'; message: string };
};

export type LoginIpcSuccessResponse = {
  ok: true;
};

export type LoginIpcResponse = LoginIpcSuccessResponse | LoginIpcErrorResponse;

/**
 * Wires the login `BrowserWindow` lifecycle to a single, temporary
 * `auth.login` IPC handler. The renderer side (`login-preload.ts` +
 * `login-window.html`) never sees tokens or the workspace id directly — it
 * only learns whether the submitted credentials were accepted. The resolved
 * `workspaceId` is returned to the *main*-process caller of `promptLogin()`,
 * which is the only place it is allowed to cross into the rest of this
 * runtime (see docs/design/ELECTRON_MAIN_RUNTIME.md "Renderer UI 是受限的 API
 * consumer").
 */
export function createLoginWindowPrompter(options: LoginWindowOptions): LoginPrompter {
  return {
    promptLogin(): Promise<LoginPromptResult> {
      return new Promise((resolve, reject) => {
        const window = options.createWindow();
        let settled = false;

        options.ipcMain.handle('auth.login', async (_event, payload): Promise<LoginIpcResponse> => {
          const parsed = parseLoginPayload(payload);

          if (!parsed.ok) {
            return {
              error: { code: 'validation_failed', message: '请填写邮箱和密码。' },
              ok: false,
            };
          }

          try {
            const result = await options.authClient.login(parsed.value);
            settled = true;
            options.ipcMain.removeHandler?.('auth.login');

            if (!window.isDestroyed()) {
              window.close();
            }

            resolve(result);
            return { ok: true };
          } catch (error) {
            return { error: toSafeLoginError(error), ok: false };
          }
        });

        window.on('closed', () => {
          if (settled) {
            return;
          }

          options.ipcMain.removeHandler?.('auth.login');
          reject(new Error('Login window was closed before authentication completed.'));
        });

        void window.loadFile(options.htmlFilePath);
      });
    },
  };
}

function parseLoginPayload(
  payload: unknown,
): { ok: true; value: { email: string; password: string } } | { ok: false } {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('email' in payload) ||
    !('password' in payload)
  ) {
    return { ok: false };
  }

  const { email, password } = payload as { email: unknown; password: unknown };

  if (
    typeof email !== 'string' ||
    typeof password !== 'string' ||
    email === '' ||
    password === ''
  ) {
    return { ok: false };
  }

  return { ok: true, value: { email, password } };
}

function toSafeLoginError(error: unknown): { code: AuthClientErrorCode; message: string } {
  if (isAuthClientErrorShape(error)) {
    return { code: error.code, message: error.safeMessage };
  }

  return { code: 'unknown', message: '登录失败。' };
}

function isAuthClientErrorShape(
  error: unknown,
): error is { code: AuthClientErrorCode; safeMessage: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'safeMessage' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    typeof (error as { safeMessage: unknown }).safeMessage === 'string'
  );
}

import { describe, expect, it } from 'bun:test';
import { AuthClientError } from '../client';
import {
  type LoginIpcMainLike,
  type LoginIpcResponse,
  type LoginWindowLike,
  createLoginWindowPrompter,
} from '../login-window';

describe('login window prompter', () => {
  it('resolves with the workspace id once auth.login succeeds, and closes the window', async () => {
    const { ipcMain, window, invokeAuthLogin } = harness();
    const authClient = {
      login: async (input: { email: string; password: string }) => {
        expect(input).toEqual({ email: 'person@example.test', password: 'correct horse' });
        return { workspaceId: 'workspace_1' };
      },
    };
    const prompter = createLoginWindowPrompter({
      authClient,
      createWindow: () => window,
      htmlFilePath: '/app/login-window.html',
      ipcMain,
    });

    const promptPromise = prompter.promptLogin();
    const response = await invokeAuthLogin({
      email: 'person@example.test',
      password: 'correct horse',
    });

    expect(response).toEqual({ ok: true });
    expect(window.closeCalls).toBe(1);
    await expect(promptPromise).resolves.toEqual({ workspaceId: 'workspace_1' });
    expect(ipcMain.removedHandlers).toEqual(['auth.login']);
  });

  it('returns a validation_failed response and does not resolve for a malformed payload', async () => {
    const { ipcMain, window, invokeAuthLogin } = harness();
    const authClient = { login: async () => ({ workspaceId: 'should-not-be-used' }) };
    const prompter = createLoginWindowPrompter({
      authClient,
      createWindow: () => window,
      htmlFilePath: '/app/login-window.html',
      ipcMain,
    });

    prompter.promptLogin().catch(() => {});
    const response = await invokeAuthLogin({ email: '', password: '' });

    expect(response).toEqual({
      error: { code: 'validation_failed', message: 'Email and password are required.' },
      ok: false,
    });
    expect(window.closeCalls).toBe(0);
  });

  it('surfaces a safe AuthClientError code without closing the window or resolving', async () => {
    const { ipcMain, window, invokeAuthLogin } = harness();
    const authClient = {
      login: async () => {
        throw new AuthClientError({
          code: 'invalid_credentials',
          retryable: false,
          safeMessage: 'Email or password is incorrect.',
        });
      },
    };
    const prompter = createLoginWindowPrompter({
      authClient,
      createWindow: () => window,
      htmlFilePath: '/app/login-window.html',
      ipcMain,
    });

    prompter.promptLogin().catch(() => {});
    const response = await invokeAuthLogin({ email: 'person@example.test', password: 'wrong' });

    expect(response).toEqual({
      error: { code: 'invalid_credentials', message: 'Email or password is incorrect.' },
      ok: false,
    });
    expect(window.closeCalls).toBe(0);
  });

  it('maps a non-AuthClientError failure to a generic unknown code without leaking internals', async () => {
    const { ipcMain, window, invokeAuthLogin } = harness();
    const authClient = {
      login: async () => {
        throw new Error('some internal detail that must not reach the renderer');
      },
    };
    const prompter = createLoginWindowPrompter({
      authClient,
      createWindow: () => window,
      htmlFilePath: '/app/login-window.html',
      ipcMain,
    });

    prompter.promptLogin().catch(() => {});
    const response = await invokeAuthLogin({ email: 'person@example.test', password: 'x' });

    expect(response).toEqual({ error: { code: 'unknown', message: 'Login failed.' }, ok: false });
  });

  it('rejects promptLogin when the window is closed before a successful login', async () => {
    const { window } = (() => {
      const w = new FakeLoginWindow();
      return { window: w };
    })();
    const ipcMain = new FakeIpcMain();
    const authClient = { login: async () => ({ workspaceId: 'unused' }) };
    const prompter = createLoginWindowPrompter({
      authClient,
      createWindow: () => window,
      htmlFilePath: '/app/login-window.html',
      ipcMain,
    });

    const promptPromise = prompter.promptLogin();
    window.emitClosed();

    await expect(promptPromise).rejects.toThrow(
      'Login window was closed before authentication completed.',
    );
    expect(ipcMain.removedHandlers).toEqual(['auth.login']);
  });

  it('loads the injected html file path', async () => {
    const ipcMain = new FakeIpcMain();
    const window = new FakeLoginWindow();
    const authClient = { login: async () => ({ workspaceId: 'unused' }) };

    createLoginWindowPrompter({
      authClient,
      createWindow: () => window,
      htmlFilePath: '/custom/path/login-window.html',
      ipcMain,
    })
      .promptLogin()
      .catch(() => {});

    expect(window.loadedFiles).toEqual(['/custom/path/login-window.html']);
  });
});

function harness() {
  const ipcMain = new FakeIpcMain();
  const window = new FakeLoginWindow();

  return {
    ipcMain,
    invokeAuthLogin: (payload: unknown) => ipcMain.invoke(payload),
    window,
  };
}

class FakeIpcMain implements LoginIpcMainLike {
  private handler: ((event: unknown, payload: unknown) => Promise<LoginIpcResponse>) | undefined;
  readonly removedHandlers: string[] = [];

  handle(
    _channel: 'auth.login',
    listener: (event: unknown, payload: unknown) => Promise<unknown>,
  ): void {
    this.handler = listener as (event: unknown, payload: unknown) => Promise<LoginIpcResponse>;
  }

  removeHandler(channel: 'auth.login'): void {
    this.removedHandlers.push(channel);
    this.handler = undefined;
  }

  async invoke(payload: unknown): Promise<LoginIpcResponse> {
    if (!this.handler) {
      throw new Error('no auth.login handler registered');
    }

    return this.handler(undefined, payload);
  }
}

class FakeLoginWindow implements LoginWindowLike {
  closeCalls = 0;
  destroyed = false;
  loadedFiles: string[] = [];
  private closedListeners: Array<() => void> = [];

  async loadFile(filePath: string): Promise<void> {
    this.loadedFiles.push(filePath);
  }

  close(): void {
    this.closeCalls += 1;
    this.destroyed = true;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  on(_event: 'closed', listener: () => void): void {
    this.closedListeners.push(listener);
  }

  emitClosed(): void {
    for (const listener of this.closedListeners) {
      listener();
    }
  }
}

import { contextBridge, ipcRenderer } from 'electron';

/**
 * Thin, genuinely-`electron`-importing preload for the login window (see
 * `main/electron-entry.ts`'s doc comment for why this project keeps such
 * files thin and manually smoke-tested rather than unit-tested under
 * `bun test`).
 *
 * This exposes exactly one method to `login-window.html`'s renderer:
 * `window.recapsyAuth.login(email, password)`, which forwards to the
 * `auth.login` IPC channel `auth/login-window.ts` registers. The renderer
 * never gets `ipcRenderer`, `contextBridge`, Node integration, or any other
 * channel — only this one allowlisted call, matching the allowlist
 * discipline `ipc/preload.ts` already applies to the main app window.
 */
contextBridge.exposeInMainWorld('recapsyAuth', {
  login: (email: string, password: string) => ipcRenderer.invoke('auth.login', { email, password }),
});

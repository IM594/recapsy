import { contextBridge, ipcRenderer } from 'electron';
import { buildPreloadAllowlist } from '../ipc/index';

/**
 * Main-window preload. Exposes only the typed IPC allowlist plus a push
 * subscription for shell status updates. Renderer never receives ipcRenderer,
 * Node APIs, filesystem, or SQLite access.
 */
const api = buildPreloadAllowlist((channel, payload) => ipcRenderer.invoke(channel, payload));

contextBridge.exposeInMainWorld('recapsyDesktop', {
  ...api,
  onStatusUpdated: (listener: (status: unknown) => void) => {
    const handler = (_event: unknown, status: unknown) => listener(status);
    ipcRenderer.on('shell.statusUpdated', handler);
    return () => {
      ipcRenderer.removeListener('shell.statusUpdated', handler);
    };
  },
});

export {
  formatPermissionLabel,
  formatTrayTooltip,
  isCaptureBlockedByPermissions,
} from './status-model';
export type { DesktopShellStatus } from './status-model';
export { createTrayIconPngBuffer } from './tray-icon';
export { createDesktopShell } from './desktop-shell';
export type {
  DesktopShell,
  DesktopShellActions,
  DesktopShellAdapters,
  DesktopShellMenu,
  DesktopShellMenuItem,
  DesktopShellOptions,
  DesktopShellStatusSource,
  DesktopShellTray,
  DesktopShellWindow,
} from './desktop-shell';

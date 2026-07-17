export {
  formatPermissionLabel,
  formatTrayTooltip,
  isCaptureBlockedByPermissions,
} from './status-model';
export type { DesktopShellStatus } from './status-model';
export { createTrayIconPngBuffer } from './tray-icon';
export { createDesktopHealthMonitor } from './health-monitor';
export type {
  DesktopHealthAlert,
  DesktopHealthAlertKind,
  DesktopHealthMonitor,
  DesktopHealthMonitorOptions,
  DesktopHealthSnapshot,
} from './health-monitor';
export { createDesktopShell } from './desktop-shell';
export type {
  DesktopShell,
  DesktopShellActions,
  DesktopShellAdapters,
  DesktopShellMenu,
  DesktopShellMenuItem,
  DesktopShellNotification,
  DesktopShellOptions,
  DesktopShellStatusSource,
  DesktopShellTray,
  DesktopShellWindow,
} from './desktop-shell';

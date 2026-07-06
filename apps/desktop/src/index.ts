export { parseDesktopConfig } from './config/config';
export type {
  DesktopConfig,
  DesktopConfigError,
  DesktopConfigErrorCode,
  DesktopConfigInput,
  DesktopConfigResult,
} from './config/config';
export { createDesktopRuntime } from './runtime/lifecycle-controller';
export type {
  DesktopRuntime,
  HelperLifecycle,
  RuntimeSnapshot,
  RuntimeStatus,
} from './runtime/types';

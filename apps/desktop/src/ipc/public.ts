export * from './index';
export { createRendererSafeSuccess, registerIpcHandlers } from './handler-registry';
export type {
  ElectronIpcMainLike,
  IpcHandler,
  IpcHandlerMap,
} from './handler-registry';

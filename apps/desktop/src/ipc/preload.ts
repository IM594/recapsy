import { IPC_CHANNEL_REGISTRY, type IpcChannelName, type IpcPreloadMethodName } from './contracts';
import type { IpcResponseEnvelope } from './errors';

export type PreloadInvoke = (
  channel: IpcChannelName,
  payload: unknown,
) => Promise<IpcResponseEnvelope<unknown>>;

export type PreloadAllowlist = Record<
  IpcPreloadMethodName,
  (payload?: unknown) => Promise<IpcResponseEnvelope<unknown>>
>;

const FORBIDDEN_PRELOAD_METHODS = new Set([
  'send',
  'invoke',
  'fs',
  'child_process',
  'helperPipe',
  'sqlite',
]);

export function buildPreloadAllowlist(invoke: PreloadInvoke): PreloadAllowlist {
  const entries = IPC_CHANNEL_REGISTRY.map((definition) => {
    if (FORBIDDEN_PRELOAD_METHODS.has(definition.methodName)) {
      throw new Error(`Unsafe preload method cannot be exposed: ${definition.methodName}`);
    }

    return [
      definition.methodName,
      (payload?: unknown) => invoke(definition.channel, payload ?? {}),
    ] as const;
  });

  return Object.fromEntries(entries) as PreloadAllowlist;
}

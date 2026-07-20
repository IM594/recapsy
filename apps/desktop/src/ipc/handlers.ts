import { IPC_CHANNEL_REGISTRY, validateIpcRequest } from './contracts';
import type { IpcChannelName } from './contracts';
import { assertRendererSafeDto } from './dto';
import { createIpcErrorEnvelope } from './errors';
import type { IpcResponseEnvelope } from './errors';

export type ElectronIpcMainLike = {
  handle(
    channel: string,
    listener: (event: unknown, payload: unknown) => unknown | Promise<unknown>,
  ): unknown;
};

export type IpcHandler = (payload: unknown) => Promise<IpcResponseEnvelope<unknown>>;
export type IpcHandlerMap = Partial<Record<IpcChannelName, IpcHandler>>;

export function registerIpcHandlers(ipcMain: ElectronIpcMainLike, handlers: IpcHandlerMap): void {
  const missingChannels = IPC_CHANNEL_REGISTRY.filter(
    ({ channel }) => typeof handlers[channel] !== 'function',
  ).map(({ channel }) => channel);

  if (missingChannels.length > 0) {
    throw new Error(`Missing IPC handlers for active channels: ${missingChannels.join(', ')}`);
  }

  for (const definition of IPC_CHANNEL_REGISTRY) {
    ipcMain.handle(definition.channel, async (_event, payload) => {
      const validation = validateIpcRequest(definition.channel, payload);

      if (!validation.ok) {
        return validation.error;
      }

      const handler = handlers[definition.channel];
      if (!handler) {
        throw new Error(`Missing IPC handler after registration: ${definition.channel}`);
      }

      return handler(validation.value);
    });
  }
}

export function createRendererSafeSuccess<TData>(data: TData): IpcResponseEnvelope<TData> {
  const safety = assertRendererSafeDto(data);

  if (!safety.ok) {
    return createIpcErrorEnvelope('unknown', 'Response failed renderer-safety validation.');
  }

  return { data, ok: true };
}

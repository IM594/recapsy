export const IPC_ERROR_CODES = [
  'unauthenticated',
  'workspace_required',
  'permission_missing',
  'policy_denied',
  'quota_exceeded',
  'offline',
  'server_unavailable',
  'provider_not_configured',
  'provider_unavailable',
  'validation_failed',
  'cancelled',
  'conflict',
  'unknown',
] as const;

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];

export type IpcError = {
  code: IpcErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

export type IpcErrorEnvelope = {
  ok: false;
  error: IpcError;
};

export type IpcSuccessEnvelope<TData> = {
  ok: true;
  data: TData;
};

export type IpcResponseEnvelope<TData> = IpcSuccessEnvelope<TData> | IpcErrorEnvelope;

export type IpcRequestEnvelope<TChannel extends string, TPayload> = {
  channel: TChannel;
  requestId: string;
  sentAt: string;
  payload: TPayload;
};

export function createIpcErrorEnvelope(
  code: IpcErrorCode,
  message: string,
  details?: Record<string, unknown>,
): IpcErrorEnvelope {
  return {
    ok: false,
    error: details
      ? {
          code,
          details,
          message,
        }
      : {
          code,
          message,
        },
  };
}

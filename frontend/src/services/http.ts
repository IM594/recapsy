import type { ErrorCode, ErrorResponse } from "@recaply/shared";
import { isErrorResponse } from "@recaply/shared";

export type RequestOptions = {
  signal?: AbortSignal;
};

function formatApiErrorDebugMessage(opts: {
  status: number;
  message: string;
  code?: ErrorCode;
  requestId?: string;
}): string {
  const parts: string[] = [opts.message, `status=${opts.status}`];
  if (opts.code) parts.push(`code=${opts.code}`);
  if (opts.requestId) parts.push(`requestId=${opts.requestId}`);
  return parts.join(" ");
}

export class ApiError extends Error {
  status: number;
  payload: unknown;
  code?: ErrorCode;
  requestId?: string;
  details?: unknown;
  debugMessage?: string;

  constructor(
    status: number,
    message: string,
    payload: unknown,
    meta?: { code?: ErrorCode; requestId?: string; details?: unknown }
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
    this.code = meta?.code;
    this.requestId = meta?.requestId;
    this.details = meta?.details;

    // Keep `message` user-friendly; put structured info into debugMessage for logs.
    this.debugMessage = formatApiErrorDebugMessage({
      status,
      message,
      code: this.code,
      requestId: this.requestId,
    });
  }

  toString(): string {
    return this.debugMessage || this.message;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractErrorMeta(payload: unknown): {
  code?: ErrorCode;
  requestId?: string;
  details?: unknown;
} | null {
  if (!isErrorResponse(payload)) return null;
  const typed = payload as ErrorResponse;
  return {
    code: typed.code,
    requestId: typed.requestId,
    details: typed.details,
  };
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (isErrorResponse(payload)) return payload.error;
  if (!isRecord(payload)) return undefined;

  const error = payload.error;
  if (typeof error === "string" && error.trim()) return error;

  const message = payload.message;
  if (typeof message === "string" && message.trim()) return message;

  return undefined;
}

async function parseResponseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const payload = await parseResponseBody(res);

  if (!res.ok) {
    const message =
      extractErrorMessage(payload) || `Request failed (${res.status})`;
    const meta = extractErrorMeta(payload);
    throw new ApiError(res.status, message, payload, meta ?? undefined);
  }

  return payload as T;
}

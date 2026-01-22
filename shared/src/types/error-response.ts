import type { ErrorCode } from "../constants/errors.js";

export type ErrorResponse = {
  error: string;
  code?: ErrorCode;
  requestId?: string;
  details?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isErrorResponse(value: unknown): value is ErrorResponse {
  if (!isRecord(value)) return false;
  const error = value.error;
  return typeof error === "string" && error.trim().length > 0;
}


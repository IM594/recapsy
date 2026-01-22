import { ERROR_CODES, type ErrorCode } from "@recaply/shared";

export class AppError extends Error {
  status: number;
  code: ErrorCode;
  details?: unknown;

  constructor(opts: { status: number; code: ErrorCode; message: string; details?: unknown }) {
    super(opts.message);
    this.name = "AppError";
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function badRequest(message: string, details?: unknown): AppError {
  return new AppError({ status: 400, code: ERROR_CODES.badRequest, message, details });
}

export function notFound(message: string, details?: unknown): AppError {
  return new AppError({ status: 404, code: ERROR_CODES.notFound, message, details });
}

export function conflict(message: string, details?: unknown): AppError {
  return new AppError({ status: 409, code: ERROR_CODES.conflict, message, details });
}


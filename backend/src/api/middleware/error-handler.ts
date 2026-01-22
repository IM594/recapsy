import type { ErrorRequestHandler } from "express";
import { ERROR_CODES } from "@recaply/shared";
import logger from "../../lib/logger";
import { isAppError } from "../errors";

function safeString(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value;
  if (value instanceof Error && value.message) return value.message;
  return "Unknown error";
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  const requestId = res.locals.requestId as string | undefined;

  const context = {
    requestId,
    method: req.method,
    url: req.originalUrl,
  };

  if (isAppError(err)) {
    logger.error(`Request failed (${err.code})`, err);
    logger.debug("context", { ...context, status: err.status });
    return res.status(err.status).json({
      error: err.message,
      code: err.code,
      requestId,
      details: err.details ?? undefined,
    });
  }

  const error = err instanceof Error ? err : new Error(safeString(err));
  logger.error(`Request failed (${ERROR_CODES.internal})`, error);
  logger.debug("context", context);

  const isProd = process.env.NODE_ENV === "production";
  const message = isProd ? "Internal server error" : error.message || "Internal server error";

  return res.status(500).json({
    error: message,
    code: ERROR_CODES.internal,
    requestId,
  });
};

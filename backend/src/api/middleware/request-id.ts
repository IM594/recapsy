import type { RequestHandler } from "express";
import crypto from "crypto";
import { HTTP_HEADERS } from "@recaply/shared";

declare global {
  // eslint-disable-next-line no-var
  var __recaplyRequestCounter: number | undefined;
}

function fallbackRequestId(): string {
  globalThis.__recaplyRequestCounter = (globalThis.__recaplyRequestCounter ?? 0) + 1;
  return `req-${Date.now()}-${globalThis.__recaplyRequestCounter}`;
}

export const requestIdMiddleware: RequestHandler = (_req, res, next) => {
  const id =
    typeof crypto.randomUUID === "function" ? crypto.randomUUID() : fallbackRequestId();

  res.locals.requestId = id;
  res.setHeader(HTTP_HEADERS.requestId, id);
  next();
};

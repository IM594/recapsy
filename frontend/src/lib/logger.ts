import { ApiError } from "@/services/http";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeJson(value: unknown): unknown {
  if (!isRecord(value)) return value;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return value;
  }
}

export function logDebug(scope: string, ...args: unknown[]) {
  if (!import.meta.env.DEV) return;
  console.log(`[${scope}]`, ...args);
}

export function logInfo(scope: string, message: string, context?: Record<string, unknown>) {
  console.log(`[${scope}] ${message}`, context ? safeJson(context) : "");
}

export function logWarn(scope: string, message: string, context?: Record<string, unknown>) {
  console.warn(`[${scope}] ${message}`, context ? safeJson(context) : "");
}

export function logError(
  scope: string,
  error: unknown,
  context?: Record<string, unknown>
) {
  const base: Record<string, unknown> = { scope };
  if (context) Object.assign(base, context);

  if (error instanceof ApiError) {
    const extra: Record<string, unknown> = {
      ...base,
      status: error.status,
      code: error.code,
      requestId: error.requestId,
    };
    if (import.meta.env.DEV) {
      extra.details = safeJson(error.details);
      extra.payload = safeJson(error.payload);
    }

    console.error(error.debugMessage || error.message, safeJson(extra));
    return;
  }

  if (error instanceof Error) {
    console.error(`[${scope}] ${error.message}`, safeJson(base), error);
    return;
  }

  console.error(`[${scope}] Unknown error`, safeJson(base), error);
}

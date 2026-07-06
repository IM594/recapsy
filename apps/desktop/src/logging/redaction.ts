const SECRET_FIELD_PATTERN = /(token|secret|password|credential|api[_-]?key|refresh[_-]?token)/i;
const PATH_FIELD_PATTERN = /(^|[_-])(path|file|directory|dir)$|path$/i;

export function redactLogPayload<T>(payload: T): T {
  return redactValue(payload, undefined) as T;
}

function redactValue(value: unknown, fieldName: string | undefined): unknown {
  if (fieldName && SECRET_FIELD_PATTERN.test(fieldName)) {
    return '[redacted:secret]';
  }

  if (fieldName && PATH_FIELD_PATTERN.test(fieldName)) {
    return '[redacted:path]';
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, undefined));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactValue(entry, key)]),
    );
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

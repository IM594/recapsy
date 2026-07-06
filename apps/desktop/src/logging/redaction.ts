const SECRET_FIELD_PATTERN =
  /(authorization|token|secret|password|credential|api[_-]?key|refresh[_-]?token)/i;
const PATH_FIELD_PATTERN = /(^|[_-])(path|file|directory|dir)$|path$/i;
const SENSITIVE_CONTENT_FIELD_PATTERN = /(body|payload|ocr|image|bytes|content)$/i;
const URL_WITH_QUERY_PATTERN = /\bhttps?:\/\/[^\s"'<>?]+[^\s"'<>]*\?[^\s"'<>]+/gi;
const FILE_URL_PATTERN = /\bfile:\/\/\/[^\s"'<>]+/gi;
const LOCAL_ABSOLUTE_PATH_PATTERN = /(?:\/Users|\/private\/tmp|\/tmp|\/var\/folders)\/[^\s"'<>]*/g;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const OPENAI_STYLE_TOKEN_PATTERN = /\bsk-[A-Za-z0-9][A-Za-z0-9._-]*/gi;
const SENSITIVE_TEXT_PATTERN =
  /\b(OCR raw text|provider response body|provider body|image bytes|image content|provider-token-[A-Za-z0-9._-]+|auth-token-[A-Za-z0-9._-]+)\b/gi;

export function redactLogPayload<T>(payload: T): T {
  return redactValue(payload, undefined) as T;
}

export function redactSensitiveString(value: string): string {
  return value
    .replace(BEARER_TOKEN_PATTERN, '[redacted:secret]')
    .replace(OPENAI_STYLE_TOKEN_PATTERN, '[redacted:secret]')
    .replace(URL_WITH_QUERY_PATTERN, redactUrlQuery)
    .replace(FILE_URL_PATTERN, '[redacted:path]')
    .replace(LOCAL_ABSOLUTE_PATH_PATTERN, '[redacted:path]')
    .replace(SENSITIVE_TEXT_PATTERN, '[redacted:content]');
}

function redactUrlQuery(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = '?[redacted:query]';
    return parsed.toString();
  } catch {
    return '[redacted:url]';
  }
}

function redactValue(value: unknown, fieldName: string | undefined): unknown {
  if (fieldName && SECRET_FIELD_PATTERN.test(fieldName)) {
    return '[redacted:secret]';
  }

  if (fieldName && PATH_FIELD_PATTERN.test(fieldName)) {
    return '[redacted:path]';
  }

  if (fieldName && SENSITIVE_CONTENT_FIELD_PATTERN.test(fieldName)) {
    return '[redacted:content]';
  }

  if (typeof value === 'string') {
    return redactSensitiveString(value);
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

export const ERROR_CODES = {
  badRequest: "bad_request",
  notFound: "not_found",
  conflict: "conflict",
  internal: "internal_error",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];


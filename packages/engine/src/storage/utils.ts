/**
 * SurrealDB SDK returns RecordId objects, not plain strings.
 * These helpers normalize rows for Zod parsing.
 */
export function stringifyId(id: unknown): string {
  if (typeof id === "string") return id;
  return String(id);
}

export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row, id: stringifyId(row.id) };
}

/** For RELATION tables where in/out are also RecordIds */
export function normalizeRelationRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    id: stringifyId(row.id),
    in: stringifyId(row.in),
    out: stringifyId(row.out),
  };
}

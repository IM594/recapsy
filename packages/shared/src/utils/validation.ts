import type { z } from "zod/v4";

/**
 * Parse data with a Zod schema, throwing a descriptive error on failure.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, context?: string): T {
  const result = schema.safeParse(data);
  if (result.success) {
    return result.data;
  }
  const prefix = context ? `[${context}] ` : "";
  const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  throw new Error(`${prefix}validation failed: ${issues}`);
}

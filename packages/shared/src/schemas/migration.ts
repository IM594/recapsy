import { z } from "zod/v4";

export const migrationRecordSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  name: z.string(),
  applied_at: z.coerce.date(),
  duration_ms: z.number().int(),
});

export type MigrationRecord = z.infer<typeof migrationRecordSchema>;

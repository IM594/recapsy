import { z } from "zod/v4";

export const settingsSchema = z.object({
  id: z.string(),
  key: z.string(),
  value: z.unknown(),
  updated_at: z.coerce.date(),
});

export type Settings = z.infer<typeof settingsSchema>;

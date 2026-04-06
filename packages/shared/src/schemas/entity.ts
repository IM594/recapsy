import { z } from "zod/v4";

export const entityTypeSchema = z.enum([
  "person",
  "app",
  "url",
  "topic",
  "project",
  "file",
  "email",
]);

export type EntityType = z.infer<typeof entityTypeSchema>;

export const entitySchema = z.object({
  id: z.string(),
  type: entityTypeSchema,
  name: z.string(),
  aliases: z.array(z.string()).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  first_seen: z.coerce.date(),
  last_seen: z.coerce.date(),
  frequency: z.number().int(),
  embedding: z.array(z.number()).nullable().optional(),
  embedding_model: z.string(),
  created_at: z.coerce.date(),
});

export type Entity = z.infer<typeof entitySchema>;

export const entityCreateSchema = z.object({
  type: entityTypeSchema,
  name: z.string(),
  aliases: z.array(z.string()).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  first_seen: z.coerce.date(),
  last_seen: z.coerce.date(),
  frequency: z.number().int().optional(),
});

export type EntityCreate = z.infer<typeof entityCreateSchema>;

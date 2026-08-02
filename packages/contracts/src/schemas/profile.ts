import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema } from './common.js';

const normalizedText = (maxLength: number) => z.string().trim().min(1).max(maxLength);

export const ProfileAliasSchema = normalizedText(100);

export const ProfileAliasesSchema = z
  .array(ProfileAliasSchema)
  .max(20)
  .superRefine((aliases, context) => {
    const normalized = new Set<string>();
    for (const alias of aliases) {
      const key = alias.toLowerCase();
      if (normalized.has(key)) {
        context.addIssue({ code: 'custom', message: 'Profile aliases must be unique.' });
        return;
      }
      normalized.add(key);
    }
  });

export const ProfileLocaleSchema = z
  .string()
  .trim()
  .min(1)
  .max(35)
  .transform((locale, context) => {
    try {
      const [canonical] = Intl.getCanonicalLocales(locale);
      if (canonical) {
        return canonical;
      }
    } catch {
      // Zod reports one stable contract error below.
    }
    context.addIssue({ code: 'custom', message: 'Profile locale must be a valid locale.' });
    return z.NEVER;
  });

export const ProfileTimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .transform((timeZone, context) => {
    if (/^(?:[+-]\d|GMT[+-])/i.test(timeZone)) {
      context.addIssue({ code: 'custom', message: 'Profile time zone must be an IANA name.' });
      return z.NEVER;
    }
    try {
      return new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone;
    } catch {
      context.addIssue({ code: 'custom', message: 'Profile time zone must be an IANA name.' });
      return z.NEVER;
    }
  });

export const UserProfileFieldsSchema = z
  .object({
    displayName: normalizedText(200),
    aliases: ProfileAliasesSchema,
    context: normalizedText(4_000).optional(),
    locale: ProfileLocaleSchema,
    timeZone: ProfileTimeZoneSchema,
  })
  .strict();

export const UserProfileSchema = UserProfileFieldsSchema.extend({
  id: IdSchema,
  workspaceId: IdSchema,
  userId: IdSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}).strict();

export const UserProfilePutRequestSchema = UserProfileFieldsSchema;
export const UserProfileReadResponseSchema = z
  .object({ profile: UserProfileSchema.nullable() })
  .strict();
export const UserProfileWriteResponseSchema = z.object({ profile: UserProfileSchema }).strict();

export type UserProfile = z.infer<typeof UserProfileSchema>;
export type UserProfilePutRequest = z.infer<typeof UserProfilePutRequestSchema>;
export type UserProfileReadResponse = z.infer<typeof UserProfileReadResponseSchema>;
export type UserProfileWriteResponse = z.infer<typeof UserProfileWriteResponseSchema>;

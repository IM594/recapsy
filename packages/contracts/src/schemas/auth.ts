import { z } from 'zod';
import { CapabilitiesResponseSchema } from './capabilities.js';
import { IdSchema, IsoDateTimeSchema } from './common.js';
import { ResolvedProviderSettingsSchema } from './provider-settings.js';
import { EntitlementSnapshotSchema } from './subscription.js';
import { WorkspaceMembershipSchema, WorkspaceSummarySchema } from './workspace.js';

export const AuthUserRoleSchema = z.enum(['user', 'admin']);
export const AuthUserStatusSchema = z.enum(['active', 'disabled', 'deleted']);

export const AuthSafeUserSchema = z
  .object({
    id: IdSchema,
    email: z.string().email(),
    displayName: z.string().nullable().optional(),
    emailVerified: z.boolean(),
    role: AuthUserRoleSchema,
    status: AuthUserStatusSchema,
  })
  .strict();

export const AuthRegisterRequestSchema = z
  .object({
    inviteCode: z.string().min(8).max(256),
    email: z.string().email(),
    password: z.string().min(8).max(1024),
  })
  .strict();

export const AuthLoginRequestSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1).max(1024),
  })
  .strict();

export const AuthLogoutRequestSchema = z
  .object({
    refreshToken: z.string().min(1).optional(),
    allSessions: z.boolean().default(false),
  })
  .strict();

export const AuthRefreshRequestSchema = z
  .object({
    refreshToken: z.string().min(1),
  })
  .strict();

export const AuthTokenPairSchema = z
  .object({
    tokenType: z.literal('bearer').default('bearer'),
    accessToken: z.string().min(1),
    accessTokenExpiresAt: IsoDateTimeSchema,
    refreshToken: z.string().min(1),
    refreshTokenExpiresAt: IsoDateTimeSchema,
  })
  .strict();

export const AuthSessionMetadataSchema = z
  .object({
    id: IdSchema,
    issuedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema.nullable().optional(),
    refreshedAt: IsoDateTimeSchema.nullable().optional(),
  })
  .strict();

export const AuthSessionSnapshotSchema = z
  .object({
    session: AuthSessionMetadataSchema,
    user: AuthSafeUserSchema,
    currentWorkspace: WorkspaceSummarySchema,
    membership: WorkspaceMembershipSchema,
    subscription: EntitlementSnapshotSchema,
    capabilities: CapabilitiesResponseSchema,
    providerSettings: ResolvedProviderSettingsSchema,
  })
  .strict();

export const AuthRegisterResponseSchema = z
  .object({
    tokens: AuthTokenPairSchema,
    session: AuthSessionSnapshotSchema,
  })
  .strict();

export const AuthLoginResponseSchema = AuthRegisterResponseSchema;

export const AuthRefreshResponseSchema = z
  .object({
    tokens: AuthTokenPairSchema,
    session: AuthSessionSnapshotSchema,
  })
  .strict();

export const AuthSessionResponseSchema = z
  .object({
    session: AuthSessionSnapshotSchema,
  })
  .strict();

export const AuthLogoutResponseSchema = z
  .object({
    sessionId: IdSchema,
    revoked: z.literal(true),
    revokedAt: IsoDateTimeSchema,
  })
  .strict();

export type AuthUserRole = z.infer<typeof AuthUserRoleSchema>;
export type AuthUserStatus = z.infer<typeof AuthUserStatusSchema>;
export type AuthSafeUser = z.infer<typeof AuthSafeUserSchema>;
export type AuthRegisterRequest = z.infer<typeof AuthRegisterRequestSchema>;
export type AuthLoginRequest = z.infer<typeof AuthLoginRequestSchema>;
export type AuthLogoutRequest = z.infer<typeof AuthLogoutRequestSchema>;
export type AuthRefreshRequest = z.infer<typeof AuthRefreshRequestSchema>;
export type AuthTokenPair = z.infer<typeof AuthTokenPairSchema>;
export type AuthSessionMetadata = z.infer<typeof AuthSessionMetadataSchema>;
export type AuthSessionSnapshot = z.infer<typeof AuthSessionSnapshotSchema>;
export type AuthRegisterResponse = z.infer<typeof AuthRegisterResponseSchema>;
export type AuthLoginResponse = z.infer<typeof AuthLoginResponseSchema>;
export type AuthRefreshResponse = z.infer<typeof AuthRefreshResponseSchema>;
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;
export type AuthLogoutResponse = z.infer<typeof AuthLogoutResponseSchema>;

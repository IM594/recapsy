import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema, MetadataSchema } from './common.js';
import { ProviderServiceSchema } from './provider-settings.js';

export const CapabilityFeatureSchema = z
  .object({
    enabled: z.boolean(),
    reason: z.string().min(1).optional(),
  })
  .strict();

export const ServerPlatformSchema = z.enum(['macos', 'windows', 'linux', 'web']);

export const CapabilitiesFeaturesSchema = z
  .object({
    auth: CapabilityFeatureSchema,
    invite: CapabilityFeatureSchema,
    manualSubscription: CapabilityFeatureSchema,
    providerSettings: CapabilityFeatureSchema,
    captureIngestion: CapabilityFeatureSchema,
    temporaryOcr: CapabilityFeatureSchema,
    textSearch: CapabilityFeatureSchema,
    embeddingSearch: CapabilityFeatureSchema,
    hybridSearch: CapabilityFeatureSchema,
    cloudSync: CapabilityFeatureSchema,
  })
  .strict();

export const ProviderAvailabilitySchema = z
  .object({
    service: ProviderServiceSchema,
    enabled: z.boolean(),
    provider: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    hasSecret: z.boolean().default(false),
    reason: z.string().min(1).optional(),
  })
  .strict();

export const CapabilitiesServerSchema = z
  .object({
    contractVersion: z.literal('v1'),
    minimumSidecarContractVersion: z.string().min(1).optional(),
    supportedPlatforms: z.array(ServerPlatformSchema).default(['macos']),
  })
  .strict();

export const CapabilitiesResponseSchema = z
  .object({
    workspaceId: IdSchema,
    features: CapabilitiesFeaturesSchema,
    limits: MetadataSchema.default({}),
    usage: MetadataSchema.default({}),
    providers: z.array(ProviderAvailabilitySchema),
    server: CapabilitiesServerSchema,
    generatedAt: IsoDateTimeSchema,
  })
  .strict();

export type CapabilityFeature = z.infer<typeof CapabilityFeatureSchema>;
export type ServerPlatform = z.infer<typeof ServerPlatformSchema>;
export type CapabilitiesFeatures = z.infer<typeof CapabilitiesFeaturesSchema>;
export type ProviderAvailability = z.infer<typeof ProviderAvailabilitySchema>;
export type CapabilitiesServer = z.infer<typeof CapabilitiesServerSchema>;
export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponseSchema>;

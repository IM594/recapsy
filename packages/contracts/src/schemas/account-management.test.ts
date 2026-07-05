import { describe, expect, it } from 'bun:test';
import {
  AdminInviteCreateRequestSchema,
  AdminInviteCreateResponseSchema,
  AdminProviderSettingCreateRequestSchema,
  AdminProviderSettingResponseSchema,
  AdminSubscriptionResponseSchema,
  ApiErrorSchema,
  AuthLoginRequestSchema,
  type AuthRegisterRequest,
  AuthRegisterRequestSchema,
  AuthRegisterResponseSchema,
  AuthSessionSnapshotSchema,
  CapabilitiesResponseSchema,
  EffectiveProviderSettingsResponseSchema,
  ProviderSettingMaskSchema,
  SessionResponseSchema,
  SubscriptionStatusSchema,
} from '../index.js';

const now = '2026-07-05T00:00:00.000Z';
const later = '2026-08-05T00:00:00.000Z';

const ids = {
  user: '11111111-1111-4111-8111-111111111111',
  workspace: '22222222-2222-4222-8222-222222222222',
  session: '33333333-3333-4333-8333-333333333333',
  plan: '44444444-4444-4444-8444-444444444444',
  subscription: '55555555-5555-4555-8555-555555555555',
  providerSetting: '66666666-6666-4666-8666-666666666666',
  invite: '77777777-7777-4777-8777-777777777777',
  admin: '88888888-8888-4888-8888-888888888888',
};

const plan = {
  id: ids.plan,
  code: 'manual_access',
  name: 'Manual Access',
  status: 'active',
  version: 1,
} as const;

const workspace = {
  id: ids.workspace,
  type: 'personal',
  name: 'Personal Workspace',
  status: 'active',
  ownerUserId: ids.user,
  createdAt: now,
  updatedAt: now,
} as const;

const membership = {
  workspaceId: ids.workspace,
  userId: ids.user,
  role: 'owner',
  status: 'active',
  joinedAt: now,
} as const;

const providerSetting = {
  id: ids.providerSetting,
  service: 'ocr',
  scopeType: 'global',
  provider: 'openai-compatible',
  endpointMask: 'https://api.example.test/v1',
  model: 'vision-default',
  status: 'active',
  priority: 0,
  defaultParams: { detail: 'high' },
  rateLimit: { requestsPerMinute: 60 },
  secretMask: {
    status: 'configured',
    hasSecret: true,
    mask: 'sk-...1234',
    last4: '1234',
    updatedAt: now,
  },
  createdAt: now,
  updatedAt: now,
} as const;

const providerSettings = {
  workspaceId: ids.workspace,
  userId: ids.user,
  resolutionOrder: ['user', 'workspace', 'global'],
  settings: [
    {
      service: 'ocr',
      resolvedFrom: 'global',
      setting: providerSetting,
    },
    {
      service: 'embedding',
      resolvedFrom: 'none',
      setting: null,
    },
  ],
  generatedAt: now,
} as const;

const capabilities = {
  workspaceId: ids.workspace,
  features: {
    auth: { enabled: true },
    invite: { enabled: true },
    manualSubscription: { enabled: true },
    providerSettings: { enabled: true },
    captureIngestion: { enabled: true },
    temporaryOcr: { enabled: true },
    textSearch: { enabled: true },
    embeddingSearch: { enabled: false, reason: 'provider_not_configured' },
    hybridSearch: { enabled: false, reason: 'hybrid_search_not_enabled' },
    cloudSync: { enabled: false, reason: 'cloud_sync_not_enabled' },
  },
  limits: { ocrJobsPerMonth: 100 },
  usage: { ocrJobsThisMonth: 0 },
  providers: [
    {
      service: 'ocr',
      enabled: true,
      provider: 'openai-compatible',
      model: 'vision-default',
      hasSecret: true,
    },
    {
      service: 'embedding',
      enabled: false,
      hasSecret: false,
      reason: 'provider_not_configured',
    },
  ],
  server: {
    contractVersion: 'v1',
    minimumSidecarContractVersion: 'v1',
    supportedPlatforms: ['macos'],
  },
  generatedAt: now,
} as const;

const entitlement = {
  workspaceId: ids.workspace,
  subscriptionId: ids.subscription,
  plan,
  status: 'active',
  features: { temporaryOcr: true, textSearch: true },
  limits: { ocrJobsPerMonth: 100 },
  usage: { ocrJobsThisMonth: 0 },
  effectiveAt: now,
} as const;

const sessionSnapshot = {
  session: {
    id: ids.session,
    issuedAt: now,
    expiresAt: later,
  },
  user: {
    id: ids.user,
    email: 'user@example.test',
    displayName: 'Recapsy User',
    emailVerified: false,
    role: 'user',
    status: 'active',
  },
  currentWorkspace: workspace,
  membership,
  subscription: entitlement,
  capabilities,
  providerSettings,
} as const;

describe('Account management auth and workspace contracts', () => {
  it('parses register/login requests and auth responses', () => {
    const registerRequest: AuthRegisterRequest = AuthRegisterRequestSchema.parse({
      inviteCode: 'invite-code-for-manual-access',
      email: 'user@example.test',
      password: 'correct horse battery staple',
    });

    expect(registerRequest.email).toBe('user@example.test');
    expect(AuthLoginRequestSchema.safeParse(registerRequest).success).toBe(false);
    expect(
      AuthLoginRequestSchema.safeParse({
        email: 'user@example.test',
        password: 'correct horse battery staple',
      }).success,
    ).toBe(true);

    const response = AuthRegisterResponseSchema.parse({
      tokens: {
        accessToken: 'access-token',
        accessTokenExpiresAt: later,
        refreshToken: 'refresh-token',
        refreshTokenExpiresAt: later,
      },
      session: sessionSnapshot,
    });

    expect(response.tokens.tokenType).toBe('bearer');
    expect(response.session.currentWorkspace.type).toBe('personal');
  });

  it('parses session snapshots without sensitive response fields', () => {
    const parsed = AuthSessionSnapshotSchema.parse(sessionSnapshot);

    expect(parsed.membership.role).toBe('owner');
    expect('passwordHash' in parsed.user).toBe(false);

    expect(
      AuthSessionSnapshotSchema.safeParse({
        ...sessionSnapshot,
        user: {
          ...sessionSnapshot.user,
          passwordHash: 'argon2id-hash',
        },
      }).success,
    ).toBe(false);
  });

  it('parses standalone session responses using workspace terminology only', () => {
    const response = {
      user: {
        id: ids.user,
        email: 'user@example.test',
        displayName: 'Recapsy User',
      },
      workspaces: [
        {
          id: ids.workspace,
          slug: 'personal',
          displayName: 'Personal Workspace',
          role: 'owner',
        },
      ],
      activeWorkspaceId: ids.workspace,
      settings: {},
      issuedAt: now,
    } as const;

    expect(SessionResponseSchema.safeParse(response).success).toBe(true);
    expect(
      SessionResponseSchema.safeParse({
        ...response,
        tenants: response.workspaces,
        activeTenantId: ids.workspace,
      }).success,
    ).toBe(false);
  });
});

describe('Account management invite contracts', () => {
  it('parses single-use invite create responses', () => {
    expect(
      AdminInviteCreateRequestSchema.safeParse({
        initialPlanId: ids.plan,
        initialTrialDays: 14,
        initialQuota: { ocrJobsPerMonth: 100 },
        expiresAt: later,
        note: 'Founder invite',
      }).success,
    ).toBe(true);

    expect(
      AdminInviteCreateRequestSchema.safeParse({
        initialPlanId: ids.plan,
        maxRedemptions: 2,
      }).success,
    ).toBe(false);

    const response = AdminInviteCreateResponseSchema.parse({
      invite: {
        id: ids.invite,
        codePrefix: 'rcp_1234',
        status: 'active',
        singleUse: true,
        initialPlan: plan,
        initialTrialDays: 14,
        initialQuota: { ocrJobsPerMonth: 100 },
        expiresAt: later,
        note: 'Founder invite',
        createdBy: {
          id: ids.admin,
          email: 'admin@example.test',
        },
        createdAt: now,
        updatedAt: now,
      },
      code: 'rcp_invite_plaintext_once',
    });

    expect(response.invite.singleUse).toBe(true);
    expect(response.code).toContain('rcp_');
  });
});

describe('Account management provider settings contracts', () => {
  it('accepts write-only secret input and masks read responses', () => {
    const createRequest = AdminProviderSettingCreateRequestSchema.parse({
      service: 'ocr',
      provider: 'openai-compatible',
      endpoint: 'https://api.example.test/v1',
      model: 'vision-default',
      secret: 'sk-live-write-only',
    });

    expect(createRequest.secret).toBe('sk-live-write-only');

    const parsed = ProviderSettingMaskSchema.parse(providerSetting);
    expect(parsed.secretMask.last4).toBe('1234');
    expect('secret' in parsed).toBe(false);

    expect(
      ProviderSettingMaskSchema.safeParse({
        ...providerSetting,
        secret: 'sk-live-should-never-read',
      }).success,
    ).toBe(false);

    expect(
      ProviderSettingMaskSchema.safeParse({
        ...providerSetting,
        encryptedSecret: 'ciphertext',
      }).success,
    ).toBe(false);

    expect(
      AdminProviderSettingResponseSchema.parse({
        setting: providerSetting,
      }).setting.secretMask.status,
    ).toBe('configured');
  });

  it('parses effective provider settings with user workspace global precedence', () => {
    const parsed = EffectiveProviderSettingsResponseSchema.parse(providerSettings);

    expect(parsed.resolutionOrder).toEqual(['user', 'workspace', 'global']);
    expect(parsed.settings[0]?.resolvedFrom).toBe('global');
  });
});

describe('Account management subscription and capabilities contracts', () => {
  it('parses subscription status responses', () => {
    expect(SubscriptionStatusSchema.parse('active')).toBe('active');
    expect(SubscriptionStatusSchema.parse('paused')).toBe('paused');

    const response = AdminSubscriptionResponseSchema.parse({
      subscription: {
        id: ids.subscription,
        workspaceId: ids.workspace,
        plan,
        status: 'paused',
        source: 'admin_manual',
        startsAt: now,
        pausedAt: now,
        cancelAtPeriodEnd: false,
        quotaOverride: { ocrJobsPerMonth: 50 },
        adminNote: 'Paused by admin',
        createdAt: now,
        updatedAt: now,
      },
      entitlement: {
        ...entitlement,
        status: 'paused',
        limits: { ocrJobsPerMonth: 50 },
      },
    });

    expect(response.subscription.status).toBe('paused');
    expect(response.entitlement.status).toBe('paused');
  });

  it('parses capabilities with cloud sync disabled explicitly', () => {
    const parsed = CapabilitiesResponseSchema.parse(capabilities);

    expect(parsed.features.cloudSync.enabled).toBe(false);
    expect(parsed.features.cloudSync.reason).toBe('cloud_sync_not_enabled');
  });
});

describe('Account management error contracts', () => {
  it('parses reusable categorized error envelopes', () => {
    const parsed = ApiErrorSchema.parse({
      error: {
        code: 'providerSettings.secret_write_only',
        category: 'providerSettings',
        message: 'Provider secrets are write-only.',
        requestId: 'req_01',
        details: { field: 'secret' },
      },
    });

    expect(parsed.error.category).toBe('providerSettings');
  });
});

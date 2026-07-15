import { describe, expect, it } from 'bun:test';
import {
  AuthLoginRequestSchema,
  type AuthRegisterRequest,
  AuthRegisterRequestSchema,
  AuthRegisterResponseSchema,
  AuthSessionSnapshotSchema,
  SessionResponseSchema,
} from '../../index.js';

const now = '2026-07-05T00:00:00.000Z';
const later = '2026-08-05T00:00:00.000Z';
const ids = {
  user: '11111111-1111-4111-8111-111111111111',
  workspace: '22222222-2222-4222-8222-222222222222',
  session: '33333333-3333-4333-8333-333333333333',
  plan: '44444444-4444-4444-8444-444444444444',
  subscription: '55555555-5555-4555-8555-555555555555',
  providerSetting: '66666666-6666-4666-8666-666666666666',
};

const sessionSnapshot = {
  session: { id: ids.session, issuedAt: now, expiresAt: later },
  user: {
    id: ids.user,
    email: 'user@example.test',
    displayName: 'Recapsy User',
    emailVerified: false,
    role: 'user',
    status: 'active',
  },
  currentWorkspace: {
    id: ids.workspace,
    type: 'personal',
    name: 'Personal Workspace',
    status: 'active',
    ownerUserId: ids.user,
    createdAt: now,
    updatedAt: now,
  },
  membership: {
    workspaceId: ids.workspace,
    userId: ids.user,
    role: 'owner',
    status: 'active',
    joinedAt: now,
  },
  subscription: {
    workspaceId: ids.workspace,
    subscriptionId: ids.subscription,
    plan: {
      id: ids.plan,
      code: 'manual_access',
      name: 'Manual Access',
      status: 'active',
      version: 1,
    },
    status: 'active',
    features: { temporaryOcr: true, textSearch: true },
    limits: { ocrJobsPerMonth: 100 },
    usage: { ocrJobsThisMonth: 0 },
    effectiveAt: now,
  },
  capabilities: {
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
  },
  providerSettings: {
    workspaceId: ids.workspace,
    userId: ids.user,
    resolutionOrder: ['user', 'workspace', 'global'],
    settings: [
      {
        service: 'ocr',
        resolvedFrom: 'global',
        setting: {
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
        },
      },
      { service: 'embedding', resolvedFrom: 'none', setting: null },
    ],
    generatedAt: now,
  },
} as const;

describe('auth contracts', () => {
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
        user: { ...sessionSnapshot.user, passwordHash: 'argon2id-hash' },
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

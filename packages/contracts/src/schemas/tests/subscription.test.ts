import { describe, expect, it } from 'bun:test';
import {
  AdminSubscriptionResponseSchema,
  EntitlementSnapshotSchema,
  SubscriptionStatusSchema,
} from '../../index.js';

const now = '2026-07-05T00:00:00.000Z';
const ids = {
  workspace: '22222222-2222-4222-8222-222222222222',
  plan: '44444444-4444-4444-8444-444444444444',
  subscription: '55555555-5555-4555-8555-555555555555',
};
const plan = {
  id: ids.plan,
  code: 'manual_access',
  name: 'Manual Access',
  status: 'active',
  version: 1,
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

describe('subscription contracts', () => {
  it('parses entitlement snapshots without changing their wire shape', () => {
    expect(EntitlementSnapshotSchema.parse(entitlement)).toEqual(entitlement);
  });

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
});

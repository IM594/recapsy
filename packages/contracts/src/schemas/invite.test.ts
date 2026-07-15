import { describe, expect, it } from 'bun:test';
import { AdminInviteCreateRequestSchema, AdminInviteCreateResponseSchema } from '../index.js';

const now = '2026-07-05T00:00:00.000Z';
const later = '2026-08-05T00:00:00.000Z';
const ids = {
  plan: '44444444-4444-4444-8444-444444444444',
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

describe('invite contracts', () => {
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
        createdBy: { id: ids.admin, email: 'admin@example.test' },
        createdAt: now,
        updatedAt: now,
      },
      code: 'rcp_invite_plaintext_once',
    });

    expect(response.invite.singleUse).toBe(true);
    expect(response.code).toContain('rcp_');
  });
});

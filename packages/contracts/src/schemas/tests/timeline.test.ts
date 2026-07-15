import { describe, expect, it } from 'bun:test';
import { TimelineQuerySchema } from '../../index.js';

const workspaceId = '22222222-2222-4222-8222-222222222222';

describe('timeline contracts', () => {
  it('parses timeline queries without changing their wire shape', () => {
    const parsed = TimelineQuerySchema.parse({
      workspaceId,
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-06T00:00:00.000Z',
      appName: 'Safari',
      cursor: 'opaque-cursor',
    });

    expect(parsed).toEqual({
      workspaceId,
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-06T00:00:00.000Z',
      appName: 'Safari',
      limit: 50,
      cursor: 'opaque-cursor',
    });
    expect(TimelineQuerySchema.safeParse({ ...parsed, tenantId: workspaceId }).success).toBe(false);
  });
});

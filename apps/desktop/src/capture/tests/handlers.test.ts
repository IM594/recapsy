import { describe, expect, it } from 'bun:test';
import { createCaptureIpcHandlers } from '../handlers';

const domainRule = {
  action: 'block_capture' as const,
  createdAt: '2026-08-03T00:00:00.000Z',
  enabled: true,
  id: 'local-github-domain',
  kind: 'domain' as const,
  pattern: 'github.com',
  scope: 'local_user' as const,
  updatedAt: '2026-08-03T00:00:00.000Z',
};

describe('capture IPC handlers', () => {
  it('adds and returns a whole-domain local rule through the generic local-rule channel', async () => {
    let received: unknown;
    const policy = {
      addLocalRule: async (input: unknown) => {
        received = input;
        return domainRule;
      },
      listLocalRules: async () => [domainRule],
    } as never;
    const handlers = createCaptureIpcHandlers({
      control: {} as never,
      policy,
      store: {} as never,
      workspaceId: 'workspace_1',
    });

    const handler = handlers['capture.addLocalRule'];
    if (!handler) throw new Error('Expected capture.addLocalRule handler.');
    const response = await handler({ kind: 'domain', pattern: 'github.com' });

    expect(received).toEqual({ kind: 'domain', pattern: 'github.com' });
    expect(response).toEqual({
      data: {
        rules: [
          {
            enabled: true,
            id: 'local-github-domain',
            kind: 'domain',
            pattern: 'github.com',
          },
        ],
      },
      ok: true,
    });
  });
});

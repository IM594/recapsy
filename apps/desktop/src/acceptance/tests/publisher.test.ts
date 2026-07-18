import { describe, expect, test } from 'bun:test';
import {
  type DesktopAcceptanceTransport,
  type DesktopAcceptanceTransportRequest,
  createDesktopAcceptanceHttpTransport,
  createDesktopAcceptancePublisher,
} from '../publisher';
import { acceptanceSnapshot } from './support';

const workspaceId = 'aa0d899f-64b5-41cb-a16f-65a1ea649db7';
const runtimeInstanceId = '3ce54e1d-5a17-4cb5-a1bc-6f64e2025dd1';

describe('desktop acceptance publisher', () => {
  test('sends an authenticated PUT with one random runtime id retained for the process lifetime', async () => {
    const requests: DesktopAcceptanceTransportRequest[] = [];
    let generatedIds = 0;
    const publisher = createDesktopAcceptancePublisher({
      accessTokenProvider: { getAccessToken: async () => 'session-access-token' },
      endpoint: 'http://127.0.0.1:3000',
      environment: { RECAPSY_DESKTOP_DEV_ACCEPTANCE: '1' },
      generateRuntimeInstanceId: () => {
        generatedIds += 1;
        return runtimeInstanceId;
      },
      isPackaged: false,
      now: () => '2026-07-18T08:00:00.000Z',
      transport: async (request) => {
        requests.push(request);
        return { body: undefined, headers: {}, status: 200 };
      },
      workspaceId,
      workspaceIdVerified: true,
    });

    expect(await publisher.tick(acceptanceSnapshot())).toEqual({ state: 'published' });
    expect(await publisher.tick(acceptanceSnapshot({ syncInputPerMinute: 8 }))).toEqual({
      state: 'published',
    });

    expect(generatedIds).toBe(1);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      method: 'PUT',
      path: '/dev/acceptance/desktop-status',
      headers: {
        authorization: 'Bearer session-access-token',
        'content-type': 'application/json',
      },
    });
    expect(requests[0]?.url.toString()).toBe('http://127.0.0.1:3000/dev/acceptance/desktop-status');
    expect(
      requests.map((request) => (request.body as { runtimeInstanceId: string }).runtimeInstanceId),
    ).toEqual([runtimeInstanceId, runtimeInstanceId]);
    const fieldNames = collectFieldNames(requests[0]?.body);
    for (const forbidden of [
      'hostname',
      'stableDeviceId',
      'bundleId',
      'path',
      'asset',
      'ocr',
      'errorMessage',
      'policyHash',
      'token',
    ]) {
      expect(fieldNames).not.toContain(forbidden);
    }
  });

  test('provides a fetch adapter that serializes only the projected JSON and ignores response bodies', async () => {
    let receivedInit: RequestInit | undefined;
    let receivedUrl: URL | undefined;
    const transport = createDesktopAcceptanceHttpTransport({
      fetch: async (url, init) => {
        receivedUrl = url;
        receivedInit = init;
        return new Response('private response body', { status: 202 });
      },
    });
    const publisher = createPublisher({ transport });

    expect(await publisher.tick(acceptanceSnapshot())).toEqual({ state: 'published' });
    expect(receivedUrl?.toString()).toBe('http://127.0.0.1:3000/dev/acceptance/desktop-status');
    expect(receivedInit?.method).toBe('PUT');
    expect(new Headers(receivedInit?.headers).get('authorization')).toBe(
      'Bearer session-access-token',
    );
    expect(JSON.parse(String(receivedInit?.body))).toMatchObject({
      schemaVersion: 2,
      workspaceId,
      completedPerMinute: 5,
      processing: 2,
      pending: 3,
      policyVersion: 'policy-primary',
      safeErrorCode: 'provider_unavailable',
    });
  });

  test('is disabled unless the flag, unpackaged runtime, and verified workspace all agree', async () => {
    const gates = [
      { environment: {}, isPackaged: false, workspaceIdVerified: true },
      {
        environment: { RECAPSY_DESKTOP_DEV_ACCEPTANCE: '0' },
        isPackaged: false,
        workspaceIdVerified: true,
      },
      {
        environment: { RECAPSY_DESKTOP_DEV_ACCEPTANCE: '1' },
        isPackaged: true,
        workspaceIdVerified: true,
      },
      {
        environment: { RECAPSY_DESKTOP_DEV_ACCEPTANCE: '1' },
        isPackaged: false,
        workspaceIdVerified: false,
      },
    ];

    for (const gate of gates) {
      let tokenReads = 0;
      let requests = 0;
      const publisher = createDesktopAcceptancePublisher({
        accessTokenProvider: {
          getAccessToken: async () => {
            tokenReads += 1;
            return 'session-access-token';
          },
        },
        endpoint: 'http://127.0.0.1:3000',
        ...gate,
        transport: async () => {
          requests += 1;
          return { body: undefined, headers: {}, status: 200 };
        },
        workspaceId,
      });

      expect(await publisher.tick(acceptanceSnapshot())).toEqual({ state: 'disabled' });
      expect(tokenReads).toBe(0);
      expect(requests).toBe(0);
    }
  });

  test('drops a busy tick and never queues a retry after a network failure', async () => {
    let rejectFirstRequest: ((reason: Error) => void) | undefined;
    let requests = 0;
    const transport: DesktopAcceptanceTransport = async () => {
      requests += 1;
      if (requests === 1) {
        return await new Promise((_resolve, reject) => {
          rejectFirstRequest = reject;
        });
      }
      return { body: undefined, headers: {}, status: 200 };
    };
    const publisher = createPublisher({ transport });

    const firstTick = publisher.tick(acceptanceSnapshot());
    await waitFor(() => rejectFirstRequest !== undefined);
    expect(await publisher.tick(acceptanceSnapshot())).toEqual({ state: 'dropped' });

    rejectFirstRequest?.(new Error('private network failure'));
    expect(await firstTick).toEqual({ state: 'failed' });
    await Promise.resolve();
    expect(requests).toBe(1);

    expect(await publisher.tick(acceptanceSnapshot())).toEqual({ state: 'published' });
    expect(requests).toBe(2);
  });

  test('does not publish or retain a tick when the access token is unavailable', async () => {
    let requests = 0;
    const publisher = createPublisher({
      accessTokenProvider: { getAccessToken: async () => null },
      transport: async () => {
        requests += 1;
        return { body: undefined, headers: {}, status: 200 };
      },
    });

    expect(await publisher.tick(acceptanceSnapshot())).toEqual({ state: 'unauthenticated' });
    expect(requests).toBe(0);
  });

  test('treats non-success responses as failed without reading or exposing response bodies', async () => {
    const privateBody = {
      error: { message: 'private server error', token: 'must-not-be-observed' },
    };
    const publisher = createPublisher({
      transport: async () => ({ body: privateBody, headers: {}, status: 503 }),
    });

    expect(await publisher.tick(acceptanceSnapshot())).toEqual({ state: 'failed' });
    expect(privateBody).toEqual({
      error: { message: 'private server error', token: 'must-not-be-observed' },
    });
  });
});

function createPublisher(
  overrides: Partial<Parameters<typeof createDesktopAcceptancePublisher>[0]> = {},
) {
  return createDesktopAcceptancePublisher({
    accessTokenProvider: { getAccessToken: async () => 'session-access-token' },
    endpoint: 'http://127.0.0.1:3000',
    environment: { RECAPSY_DESKTOP_DEV_ACCEPTANCE: '1' },
    generateRuntimeInstanceId: () => runtimeInstanceId,
    isPackaged: false,
    now: () => '2026-07-18T08:00:00.000Z',
    transport: async () => ({ body: undefined, headers: {}, status: 200 }),
    workspaceId,
    workspaceIdVerified: true,
    ...overrides,
  });
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error('Condition was not reached.');
}

function collectFieldNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectFieldNames);
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  return Object.entries(value).flatMap(([key, entry]) => [key, ...collectFieldNames(entry)]);
}

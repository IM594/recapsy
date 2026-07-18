import { randomUUID } from 'node:crypto';
import type { DevAcceptanceDesktopStatus } from '@recapsy/contracts';
import { type DesktopAcceptanceSnapshot, projectDesktopAcceptanceStatus } from './projection';

export type DesktopAcceptanceTransportRequest = {
  body: DevAcceptanceDesktopStatus;
  headers: Record<string, string>;
  method: 'PUT';
  path: '/dev/acceptance/desktop-status';
  query: Record<string, string>;
  url: URL;
};

export type DesktopAcceptanceTransportResponse = {
  body?: unknown;
  headers?: Record<string, string>;
  status: number;
};

export type DesktopAcceptanceTransport = (
  request: DesktopAcceptanceTransportRequest,
) => Promise<DesktopAcceptanceTransportResponse>;

export type DesktopAcceptanceFetch = (input: URL, init: RequestInit) => Promise<Response>;

export type DesktopAcceptanceAccessTokenProvider = {
  getAccessToken(): Promise<string | null>;
};

export type DesktopAcceptancePublisherResult = {
  state: 'disabled' | 'dropped' | 'failed' | 'published' | 'unauthenticated';
};

export type DesktopAcceptancePublisher = {
  tick(snapshot: DesktopAcceptanceSnapshot): Promise<DesktopAcceptancePublisherResult>;
};

export type DesktopAcceptancePublisherOptions = {
  accessTokenProvider: DesktopAcceptanceAccessTokenProvider;
  endpoint: string;
  environment: Readonly<Record<string, string | undefined>>;
  generateRuntimeInstanceId?(): string;
  isPackaged: boolean;
  now?(): string;
  transport: DesktopAcceptanceTransport;
  workspaceId: string;
  workspaceIdVerified: boolean;
};

export type DesktopAcceptanceHttpTransportOptions = {
  fetch?: DesktopAcceptanceFetch;
};

const DESKTOP_STATUS_PATH = '/dev/acceptance/desktop-status' as const;

export function createDesktopAcceptanceHttpTransport(
  options: DesktopAcceptanceHttpTransportOptions = {},
): DesktopAcceptanceTransport {
  const fetchRequest = options.fetch ?? globalThis.fetch;
  return async (request) => {
    const response = await fetchRequest(request.url, {
      body: JSON.stringify(request.body),
      headers: request.headers,
      method: request.method,
    });
    return { status: response.status };
  };
}

export function createDesktopAcceptancePublisher(
  options: DesktopAcceptancePublisherOptions,
): DesktopAcceptancePublisher {
  const enabled =
    options.environment.RECAPSY_DESKTOP_DEV_ACCEPTANCE === '1' &&
    !options.isPackaged &&
    options.workspaceIdVerified;
  const runtimeInstanceId = (options.generateRuntimeInstanceId ?? randomUUID)();
  const now = options.now ?? (() => new Date().toISOString());
  let inFlight = false;

  return {
    async tick(snapshot) {
      if (!enabled) {
        return { state: 'disabled' };
      }
      if (inFlight) {
        return { state: 'dropped' };
      }

      inFlight = true;
      try {
        const accessToken = await options.accessTokenProvider.getAccessToken();
        if (!accessToken) {
          return { state: 'unauthenticated' };
        }
        const status = projectDesktopAcceptanceStatus({
          runtimeInstanceId,
          workspaceId: options.workspaceId,
          observedAt: now(),
          snapshot,
        });
        const response = await options.transport({
          body: status,
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
          },
          method: 'PUT',
          path: DESKTOP_STATUS_PATH,
          query: {},
          url: new URL(DESKTOP_STATUS_PATH, options.endpoint),
        });
        return response.status >= 200 && response.status < 300
          ? { state: 'published' }
          : { state: 'failed' };
      } catch {
        return { state: 'failed' };
      } finally {
        inFlight = false;
      }
    },
  };
}

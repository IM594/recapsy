import { expect } from 'bun:test';
import type { AiRuntime, createAiRuntime } from '../../../server/src/ai/index';
import type { InMemoryCaptureRepository } from '../../../server/src/capture/index';
import type {
  InMemoryProviderSettingsRepository,
  createProviderCredentialResolver,
} from '../../../server/src/provider-settings/index';
import type { TestHttpAppOptions, createTestHttpApp } from '../../../server/tests/test-support';
import { startLoopbackHttpServer } from './loopback-http-server';

type CaptureRepositorySnapshot = ReturnType<InMemoryCaptureRepository['snapshot']>;

export type ServerHttpHarness = {
  endpoint: string;
  bootstrapUser(email: string): Promise<{ accessToken: string; workspaceId: string }>;
  captureSnapshot(): CaptureRepositorySnapshot;
  stop(): void;
};

export type ServerHttpHarnessOptions = {
  aiRuntime?: AiRuntime;
  useAppDefaultOcrRunner?: boolean;
};

type ServerModules = {
  InMemoryCaptureRepository: new () => InMemoryCaptureRepository;
  InMemoryProviderSettingsRepository: new () => InMemoryProviderSettingsRepository;
  createProviderCredentialResolver: typeof createProviderCredentialResolver;
  createAiRuntime: typeof createAiRuntime;
  createTestHttpApp: typeof createTestHttpApp;
};

export const testUserPassword = 'correct horse battery staple';

export async function startServerHttpHarness(
  options: ServerHttpHarnessOptions = {},
): Promise<ServerHttpHarness> {
  const modules = await loadServerModules();
  let listener: ReturnType<typeof startLoopbackHttpServer> | undefined;

  try {
    const captureRepository = new modules.InMemoryCaptureRepository();
    const providerSettingsRepository = new modules.InMemoryProviderSettingsRepository();
    const config: TestHttpAppOptions['config'] = {
      ADMIN_BOOTSTRAP_TOKEN: 'test-admin-bootstrap-token',
      CAPTURE_DOWNTIME_MONITOR_BATCH_SIZE: 1_000,
      CAPTURE_DOWNTIME_MONITOR_INTERVAL_MS: 60_000,
      CAPTURE_DOWNTIME_STALE_THRESHOLD_MS: 180_000,
      CORS_ALLOWED_ORIGINS: [],
      DATABASE_URL: 'postgresql://test',
      EMBEDDING_INDEXER_BATCH_SIZE: 16,
      EMBEDDING_INDEXER_INTERVAL_MS: 15_000,
      EMBEDDING_INDEXER_MAX_ATTEMPTS: 5,
      EMBEDDING_INDEXER_TIMEOUT_MS: 30_000,
      LOG_LEVEL: 'error',
      NODE_ENV: options.useAppDefaultOcrRunner ? 'production' : 'test',
      OCR_MAX_INPUT_BYTES: 1024 * 1024,
      OCR_PROXY_MAX_INFLIGHT_PER_USER: 2,
      OCR_PROXY_TIMEOUT_MS: 60_000,
      PORT: 0,
      PROVIDER_ENCRYPTION_SECRET: 'test-provider-secret-with-enough-entropy',
      RETENTION_WORKER_BATCH_SIZE: 100,
      RETENTION_WORKER_INTERVAL_MS: 60_000,
      SESSION_SECRET: 'test-session-secret-with-enough-entropy',
    };
    const aiRuntime =
      options.aiRuntime ??
      (options.useAppDefaultOcrRunner
        ? modules.createAiRuntime({
            providerCredentialResolver: modules.createProviderCredentialResolver({
              config,
              repository: providerSettingsRepository,
            }),
          })
        : undefined);
    const app = modules.createTestHttpApp({
      ...(aiRuntime ? { aiRuntime } : {}),
      captureRepository,
      config,
      logger: noopLogger,
      providerSettingsRepository,
    }).app;
    listener = startLoopbackHttpServer(app.fetch);
    const endpoint = listener.endpoint;

    return {
      endpoint,
      async bootstrapUser(email) {
        const inviteResponse = await fetch(`${endpoint}/v1/bootstrap/invites`, {
          body: JSON.stringify({
            initialQuota: { ocrJobsPerMonth: 100, searchQueriesPerMonth: 1000 },
            initialTrialDays: 14,
            note: 'Desktop HTTP integration test',
          }),
          headers: {
            authorization: 'Bearer test-admin-bootstrap-token',
            'content-type': 'application/json',
          },
          method: 'POST',
        });
        expect(inviteResponse.status).toBe(201);
        const invite = (await inviteResponse.json()) as { code: string };
        const registrationResponse = await fetch(`${endpoint}/v1/auth/register`, {
          body: JSON.stringify({ email, inviteCode: invite.code, password: testUserPassword }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        });
        expect(registrationResponse.status).toBe(201);
        const registered = (await registrationResponse.json()) as {
          session: { currentWorkspace: { id: string } };
          tokens: { accessToken: string };
        };
        return {
          accessToken: registered.tokens.accessToken,
          workspaceId: registered.session.currentWorkspace.id,
        };
      },
      captureSnapshot() {
        return captureRepository.snapshot();
      },
      stop() {
        listener?.stop();
        listener = undefined;
      },
    };
  } catch (error) {
    listener?.stop();
    throw error;
  }
}

const noopLogger: TestHttpAppOptions['logger'] = {
  debug() {},
  error() {},
  info() {},
  warn() {},
} as unknown as TestHttpAppOptions['logger'];

async function loadServerModules(): Promise<ServerModules> {
  const testSupportModule = await import(
    new URL('../../../server/tests/test-support.ts', import.meta.url).href
  );
  const aiRuntimeModule = await import(
    new URL('../../../server/src/ai/index.ts', import.meta.url).href
  );
  const captureRepositoryModule = await import(
    new URL('../../../server/src/capture/index.ts', import.meta.url).href
  );
  const providerSettingsModule = await import(
    new URL('../../../server/src/provider-settings/index.ts', import.meta.url).href
  );

  return {
    InMemoryCaptureRepository: captureRepositoryModule.InMemoryCaptureRepository,
    InMemoryProviderSettingsRepository: providerSettingsModule.InMemoryProviderSettingsRepository,
    createProviderCredentialResolver: providerSettingsModule.createProviderCredentialResolver,
    createAiRuntime: aiRuntimeModule.createAiRuntime,
    createTestHttpApp: testSupportModule.createTestHttpApp,
  };
}

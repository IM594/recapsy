import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DESKTOP_SOURCE_ROOT = path.resolve(import.meta.dir);
const CAPABILITY_DIRECTORIES = [
  'auth',
  'capture',
  'helper',
  'ipc',
  'server',
  'status',
  'storage',
  'sync',
] as const;
const IMPORT_PATTERN = /from\s+['"]([^'"]+)['"]/g;

async function readSource(relativePath: string): Promise<string> {
  return readFile(path.join(DESKTOP_SOURCE_ROOT, relativePath), 'utf8');
}

describe('desktop architecture boundaries', () => {
  it('gives every existing capability a public module surface', async () => {
    const publicSurfaces = await Promise.all(
      CAPABILITY_DIRECTORIES.map((directory) => readSource(`${directory}/public.ts`)),
    );

    expect(publicSurfaces.every((source) => source.includes('export'))).toBe(true);
  });

  it('keeps the Node SQLite adapter out of the storage public surface', async () => {
    const [publicSource, compositionSource] = await Promise.all([
      readSource('storage/public.ts'),
      readSource('storage/composition.ts'),
    ]);

    expect(publicSource).not.toContain('node-driver');
    expect(publicSource).not.toContain('createNodeSqliteDatabase');
    expect(compositionSource).toContain('createNodeSqliteDatabase');
  });

  it('limits the storage composition surface to the Electron composition root', async () => {
    const violations: string[] = [];
    const glob = new Bun.Glob('**/*.ts');

    for await (const relativePath of glob.scan({ cwd: DESKTOP_SOURCE_ROOT })) {
      if (relativePath.endsWith('.test.ts') || relativePath.includes('/__tests__/')) {
        continue;
      }

      const source = await readSource(relativePath);
      for (const match of source.matchAll(IMPORT_PATTERN)) {
        const specifier = match[1];
        if (!specifier?.startsWith('.')) {
          continue;
        }

        const targetPath = resolveLocalImport(relativePath, specifier);
        if (targetPath === 'storage/composition' && relativePath !== 'main/electron-entry.ts') {
          violations.push(`${relativePath} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps server transport types independent from auth, IPC, and storage internals', async () => {
    const source = await readSource('server/types.ts');

    expect(source).not.toMatch(/from ['"]\.\.\/auth\//);
    expect(source).not.toMatch(/from ['"]\.\.\/ipc\//);
    expect(source).not.toMatch(/from ['"]\.\.\/storage\//);
  });

  it('lets sync own its server and queue ports', async () => {
    const source = await readSource('sync/types.ts');

    expect(source).not.toMatch(/from ['"]\.\.\/server\//);
    expect(source).not.toContain('OperationalStoreRepository');
    expect(source).toContain('export type SyncServerApi =');
    expect(source).toContain('export type SyncQueueStore =');
    expect(source).toContain('export type SyncAssetReader =');
  });

  it('gives production consumers narrow operational store ports', async () => {
    const consumers = [
      ['capture/helper-controller.ts', ['HelperStateStore']],
      ['capture/helper-event-handler.ts', ['CaptureIntakeStore', 'HelperStateStore']],
      ['capture/handlers.ts', ['CaptureHistoryReader']],
      ['capture/runtime.ts', ['CaptureRuntimeStore']],
      ['storage/reconciliation.ts', ['AssetReconciliationStore']],
      ['sync/runtime.ts', ['SyncQueueStore']],
      ['main/runtime.ts', ['StoreLifecycle', 'DesktopStore']],
    ] as const;
    const violations: string[] = [];

    for (const [relativePath, expectedPorts] of consumers) {
      const source = await readSource(relativePath);
      if (/\bOperationalStoreRepository\b/.test(source)) {
        violations.push(`${relativePath} depends on OperationalStoreRepository`);
      }
      for (const expectedPort of expectedPorts) {
        if (!new RegExp(`\\b${expectedPort}\\b`).test(source)) {
          violations.push(`${relativePath} does not depend on ${expectedPort}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('publishes capture and storage operational ports from capability surfaces', async () => {
    const [capturePublicSource, storagePublicSource] = await Promise.all([
      readSource('capture/public.ts'),
      readSource('storage/public.ts'),
    ]);
    const sourceFiles: string[] = [];
    const glob = new Bun.Glob('**/*.ts');
    for await (const relativePath of glob.scan({ cwd: DESKTOP_SOURCE_ROOT })) {
      sourceFiles.push(relativePath);
    }

    const violations: string[] = [];
    if (!sourceFiles.includes('capture/store.ts')) {
      violations.push('capture/store.ts is missing');
    }
    for (const symbol of [
      'CaptureIntakeStore',
      'HelperStateStore',
      'CaptureHistoryReader',
      'CaptureRuntimeStore',
    ]) {
      if (!new RegExp(`\\b${symbol}\\b`).test(capturePublicSource)) {
        violations.push(`capture/public.ts does not export ${symbol}`);
      }
    }
    for (const symbol of ['AssetReconciliationStore', 'StoreLifecycle']) {
      if (!new RegExp(`\\b${symbol}\\b`).test(storagePublicSource)) {
        violations.push(`storage/public.ts does not export ${symbol}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('requires an explicit access token provider at the server API boundary', async () => {
    const [typesSource, clientSource] = await Promise.all([
      readSource('server/types.ts'),
      readSource('server/client.ts'),
    ]);

    expect(typesSource).not.toContain('ServerApiTokenSource');
    expect(typesSource).not.toContain('tokenStore');
    expect(clientSource).not.toContain('tokenStore');
  });

  it('keeps the sync scheduler independent from IPC and concrete server errors', async () => {
    const source = await readSource('sync/scheduler.ts');

    expect(source).not.toMatch(/from ['"]\.\.\/ipc/);
    expect(source).not.toMatch(/from ['"]\.\.\/server/);
    expect(source).not.toContain('ServerApiError');
  });

  it('gives retry policy its own sync module and test ownership', async () => {
    const [schedulerSource, publicSource] = await Promise.all([
      readSource('sync/scheduler.ts'),
      readSource('sync/public.ts'),
    ]);
    const sourceFiles: string[] = [];
    const glob = new Bun.Glob('**/*.ts');
    for await (const relativePath of glob.scan({ cwd: DESKTOP_SOURCE_ROOT })) {
      sourceFiles.push(relativePath);
    }

    const violations: string[] = [];
    if (!sourceFiles.includes('sync/retry.ts')) {
      violations.push('sync/retry.ts is missing');
    }
    if (!sourceFiles.includes('sync/retry.test.ts')) {
      violations.push('sync/retry.test.ts is missing');
    }
    if (sourceFiles.includes('sync/retry-backoff.test.ts')) {
      violations.push('sync/retry-backoff.test.ts is still present');
    }
    if (/export function computeRetryBackoffDelayMs\s*\(/.test(schedulerSource)) {
      violations.push('sync/scheduler.ts still declares computeRetryBackoffDelayMs');
    }
    if (
      !/import\s*\{[^}]*\bcomputeRetryBackoffDelayMs\b[^}]*\}\s*from\s*['"]\.\/retry['"]/s.test(
        schedulerSource,
      )
    ) {
      violations.push('sync/scheduler.ts does not import computeRetryBackoffDelayMs from ./retry');
    }
    if (
      !/export\s*\{[^}]*\bcomputeRetryBackoffDelayMs\b[^}]*\}\s*from\s*['"]\.\/retry['"]/s.test(
        publicSource,
      )
    ) {
      violations.push('sync/public.ts does not export computeRetryBackoffDelayMs from ./retry');
    }
    if (
      /export\s*\{[^}]*\bcomputeRetryBackoffDelayMs\b[^}]*\}\s*from\s*['"]\.\/scheduler['"]/s.test(
        publicSource,
      )
    ) {
      violations.push('sync/public.ts still exports computeRetryBackoffDelayMs from ./scheduler');
    }

    expect(violations).toEqual([]);
  });

  it('routes every production import into a capability through its public surface', async () => {
    const violations: string[] = [];
    const glob = new Bun.Glob('**/*.ts');

    for await (const relativePath of glob.scan({ cwd: DESKTOP_SOURCE_ROOT })) {
      if (relativePath.endsWith('.test.ts') || relativePath.includes('/__tests__/')) {
        continue;
      }

      const sourceCapability = capabilityForPath(relativePath);
      const source = await readSource(relativePath);
      for (const match of source.matchAll(IMPORT_PATTERN)) {
        const specifier = match[1];
        if (!specifier?.startsWith('.')) {
          continue;
        }

        const targetPath = resolveLocalImport(relativePath, specifier);
        const targetCapability = capabilityForPath(targetPath);
        if (!targetCapability || targetCapability === sourceCapability) {
          continue;
        }

        const isCompositionRootStorageImport =
          relativePath === 'main/electron-entry.ts' && targetPath === 'storage/composition';
        if (targetPath !== `${targetCapability}/public` && !isCompositionRootStorageImport) {
          violations.push(`${relativePath} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps capture lifecycle independent from the helper controller implementation', async () => {
    const source = await readSource('capture/lifecycle.ts');

    expect(source).not.toMatch(/from ['"]\.\/helper-controller['"]/);
    expect(source).toMatch(/from ['"]\.\.\/helper\/public['"]/);
  });

  it('keeps helper adapters independent from the status capability', async () => {
    const sources = await Promise.all([
      readSource('helper/mock-controller.ts'),
      readSource('helper/process-client.ts'),
    ]);

    for (const source of sources) {
      expect(source).not.toMatch(/from ['"]\.\.\/status\//);
    }
  });

  it('uses capability context instead of repeating it in filenames and public symbols', async () => {
    const sourceFiles: string[] = [];
    const productionSources: string[] = [];
    const glob = new Bun.Glob('**/*.ts');

    for await (const relativePath of glob.scan({ cwd: DESKTOP_SOURCE_ROOT })) {
      sourceFiles.push(relativePath);
      if (!relativePath.endsWith('.test.ts') && !relativePath.includes('/__tests__/')) {
        productionSources.push(await readSource(relativePath));
      }
    }

    const retiredPaths = [
      'capture/capture-helper-controller.ts',
      'capture/capture-helper-event-intake.ts',
      'capture/capture-runtime.ts',
      'main/electron-main-runtime.ts',
      'sync/ocr-screen-text-mapping.ts',
    ];
    const requiredPaths = [
      'capture/helper-controller.ts',
      'capture/helper-event-handler.ts',
      'capture/runtime.ts',
      'main/runtime.ts',
      'sync/screen-text.ts',
    ];
    const source = productionSources.join('\n');

    expect(retiredPaths.filter((relativePath) => sourceFiles.includes(relativePath))).toEqual([]);
    expect(requiredPaths.filter((relativePath) => !sourceFiles.includes(relativePath))).toEqual([]);
    expect(source).not.toMatch(/\bCaptureHelperEventIntake\b/);
    expect(source).not.toMatch(/\bcreateCaptureHelperEventIntake\b/);
    expect(source).not.toMatch(/\bderiveScreenTextFromOcrResponse\b/);
    expect(source).toMatch(/\bCaptureHelperEventHandler\b/);
    expect(source).toMatch(/\bcreateCaptureHelperEventHandler\b/);
    expect(source).toMatch(/\bmapOcrScreenText\b/);
  });

  it('uses concise capability and adapter paths', async () => {
    const sourceFiles: string[] = [];
    const productionSources: string[] = [];
    const glob = new Bun.Glob('**/*.ts');

    for await (const relativePath of glob.scan({ cwd: DESKTOP_SOURCE_ROOT })) {
      sourceFiles.push(relativePath);
      if (!relativePath.endsWith('.test.ts') && !relativePath.includes('/__tests__/')) {
        productionSources.push(await readSource(relativePath));
      }
    }

    const retiredPaths = [
      'server-api/client.ts',
      'runtime/ipc-handlers.ts',
      'auth/auth-client.ts',
      'auth/session-startup.ts',
      'auth/token-store.ts',
      'auth/login-window-preload.ts',
      'helper/spawn-capture-helper-client.ts',
      'helper/dev-helper-process.ts',
      'storage/sqlite-operational-store.ts',
      'storage/memory-operational-store.ts',
      'storage/node-sqlite-driver.ts',
      'storage/bun-sqlite-driver.ts',
      'storage/asset-reconciliation.ts',
      'sync/startup-recovery.ts',
      'sync/sync-loop.ts',
      'sync/sync-runtime.ts',
      'sync/ipc-handlers.ts',
      'capture/ipc-handlers.ts',
      'ipc/handler-registry.ts',
      'main/keychain-secret-store.ts',
    ];
    const requiredPaths = [
      'server/client.ts',
      'status/handlers.ts',
      'auth/client.ts',
      'auth/session.ts',
      'auth/tokens.ts',
      'auth/login-preload.ts',
      'helper/process-client.ts',
      'helper/dev-process.ts',
      'storage/sqlite-store.ts',
      'storage/memory-store.ts',
      'storage/node-driver.ts',
      'storage/bun-driver.ts',
      'storage/reconciliation.ts',
      'sync/recovery.ts',
      'sync/loop.ts',
      'sync/runtime.ts',
      'sync/handlers.ts',
      'capture/handlers.ts',
      'ipc/handlers.ts',
      'main/safe-storage.ts',
    ];
    const source = productionSources.join('\n');

    expect(retiredPaths.filter((relativePath) => sourceFiles.includes(relativePath))).toEqual([]);
    expect(requiredPaths.filter((relativePath) => !sourceFiles.includes(relativePath))).toEqual([]);
    expect(source).not.toMatch(/\bcreateElectronKeychainSecretStore\b/);
    expect(source).not.toMatch(/\bcreateSpawnCaptureHelperClient\b/);
    expect(source).not.toMatch(/\bcreateSqliteOperationalStore\b/);
    expect(source).not.toMatch(/\bcreateInMemoryOperationalStore\b/);
    expect(source).not.toMatch(/\bcreateRuntimeIpcHandlers\b/);
    expect(source).toMatch(/\bcreateSafeStorageSecretStore\b/);
    expect(source).toMatch(/\bcreateHelperProcessClient\b/);
    expect(source).toMatch(/\bcreateSqliteStore\b/);
    expect(source).toMatch(/\bcreateMemoryStore\b/);
    expect(source).toMatch(/\bcreateStatusHandlers\b/);
  });

  it('owns capture lifecycle in the capture capability instead of a generic desktop runtime', async () => {
    const sourceFiles: string[] = [];
    const productionSources: string[] = [];
    const glob = new Bun.Glob('**/*.ts');

    for await (const relativePath of glob.scan({ cwd: DESKTOP_SOURCE_ROOT })) {
      sourceFiles.push(relativePath);
      if (!relativePath.endsWith('.test.ts') && !relativePath.includes('/__tests__/')) {
        productionSources.push(await readSource(relativePath));
      }
    }

    const retiredPaths = [
      'runtime/lifecycle-controller.ts',
      'runtime/runtime.test.ts',
      'runtime/types.ts',
    ];
    const requiredPaths = ['capture/lifecycle.ts', 'capture/lifecycle.test.ts'];
    const source = productionSources.join('\n');

    expect(retiredPaths.filter((relativePath) => sourceFiles.includes(relativePath))).toEqual([]);
    expect(requiredPaths.filter((relativePath) => !sourceFiles.includes(relativePath))).toEqual([]);
    expect(source).not.toMatch(/\bDesktopRuntime\b/);
    expect(source).not.toMatch(/\bDesktopRuntimeOptions\b/);
    expect(source).not.toMatch(/\bRuntimeSnapshot\b/);
    expect(source).not.toMatch(/\bRuntimeStatus\b/);
    expect(source).not.toMatch(/\bcreateDesktopRuntime\b/);
    expect(source).not.toContain('captureRuntime.runtime');
    expect(source).toMatch(/\bCaptureLifecycle\b/);
    expect(source).toMatch(/\bCaptureLifecycleOptions\b/);
    expect(source).toMatch(/\bCaptureLifecycleSnapshot\b/);
    expect(source).toMatch(/\bCaptureLifecycleStatus\b/);
    expect(source).toMatch(/\bcreateCaptureLifecycle\b/);
    expect(source).toContain('captureRuntime.lifecycle');
  });

  it('keeps session startup out of the Electron lifecycle coordinator', async () => {
    const [runtimeSource, sessionStartupSource] = await Promise.all([
      readSource('main/runtime.ts'),
      readSource('auth/session.ts'),
    ]);

    expect(runtimeSource).not.toContain('async function resolveWorkspaceId');
    expect(runtimeSource).not.toContain('console.warn(');
    expect(runtimeSource).toContain('createSessionStartup');
    expect(sessionStartupSource).toContain('export function createSessionStartup');
  });

  it('gives capture ownership of helper orchestration and renderer projections', async () => {
    const [runtimeSource, captureRuntimeSource, captureHandlersSource] = await Promise.all([
      readSource('main/runtime.ts'),
      readSource('capture/runtime.ts'),
      readSource('capture/handlers.ts'),
    ]);

    expect(runtimeSource).not.toContain('createCaptureHelperController');
    expect(runtimeSource).not.toContain('createCaptureHelperEventHandler');
    expect(runtimeSource).not.toContain('buildCaptureStatusDto');
    expect(runtimeSource).not.toContain('buildRecentEventsDto');
    expect(runtimeSource).toContain('createCaptureRuntime');
    expect(runtimeSource).toContain('createCaptureIpcHandlers');
    expect(captureRuntimeSource).toContain('export function createCaptureRuntime');
    expect(captureHandlersSource).toContain('export function createCaptureIpcHandlers');
  });

  it('gives sync ownership of recovery, scheduler, loop startup, and queue IPC', async () => {
    const [runtimeSource, syncRuntimeSource, syncHandlersSource] = await Promise.all([
      readSource('main/runtime.ts'),
      readSource('sync/runtime.ts'),
      readSource('sync/handlers.ts'),
    ]);

    expect(runtimeSource).not.toContain('createSyncScheduler');
    expect(runtimeSource).not.toContain('recoverInterruptedOutboxJobs');
    expect(runtimeSource).not.toContain('createSyncQueueSummary');
    expect(runtimeSource).toContain('createSyncRuntime');
    expect(runtimeSource).toContain('createSyncIpcHandlers');
    expect(syncRuntimeSource).toContain('export function createSyncRuntime');
    expect(syncHandlersSource).toContain('export function createSyncIpcHandlers');
  });

  it('keeps IPC contract registration in the IPC capability', async () => {
    const [runtimeSource, registrySource] = await Promise.all([
      readSource('main/runtime.ts'),
      readSource('ipc/handlers.ts'),
    ]);

    expect(runtimeSource).not.toContain('IPC_CHANNEL_REGISTRY');
    expect(runtimeSource).not.toContain('REAL_IPC_HANDLERS');
    expect(runtimeSource).not.toContain('validateIpcRequest');
    expect(runtimeSource).toContain('registerIpcHandlers');
    expect(registrySource).toContain('export function registerIpcHandlers');
  });
});

function capabilityForPath(relativePath: string) {
  return CAPABILITY_DIRECTORIES.find(
    (directory) => relativePath === directory || relativePath.startsWith(`${directory}/`),
  );
}

function resolveLocalImport(sourcePath: string, specifier: string) {
  return path.posix
    .normalize(path.posix.join(path.posix.dirname(sourcePath), specifier))
    .replace(/[.](?:js|ts)$/, '');
}

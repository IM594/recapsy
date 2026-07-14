import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DESKTOP_SOURCE_ROOT = path.resolve(import.meta.dir);
const CAPABILITY_DIRECTORIES = [
  'auth',
  'capture',
  'helper',
  'ipc',
  'runtime',
  'server-api',
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

    expect(publicSource).not.toContain('node-sqlite-driver');
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

  it('keeps server-api transport types independent from auth, IPC, and storage internals', async () => {
    const source = await readSource('server-api/types.ts');

    expect(source).not.toMatch(/from ['"]\.\.\/auth\//);
    expect(source).not.toMatch(/from ['"]\.\.\/ipc\//);
    expect(source).not.toMatch(/from ['"]\.\.\/storage\//);
  });

  it('lets sync own its server and queue ports', async () => {
    const source = await readSource('sync/types.ts');

    expect(source).not.toMatch(/from ['"]\.\.\/server-api\//);
    expect(source).not.toContain('OperationalStoreRepository');
    expect(source).toContain('export type SyncServerApi =');
    expect(source).toContain('export type SyncQueueStore =');
    expect(source).toContain('export type SyncAssetReader =');
  });

  it('requires an explicit access token provider at the server API boundary', async () => {
    const [typesSource, clientSource] = await Promise.all([
      readSource('server-api/types.ts'),
      readSource('server-api/client.ts'),
    ]);

    expect(typesSource).not.toContain('ServerApiTokenSource');
    expect(typesSource).not.toContain('tokenStore');
    expect(clientSource).not.toContain('tokenStore');
  });

  it('keeps the sync scheduler independent from IPC and concrete server errors', async () => {
    const source = await readSource('sync/scheduler.ts');

    expect(source).not.toMatch(/from ['"]\.\.\/ipc/);
    expect(source).not.toMatch(/from ['"]\.\.\/server-api/);
    expect(source).not.toContain('ServerApiError');
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

  it('keeps helper adapters independent from the runtime capability', async () => {
    const sources = await Promise.all([
      readSource('helper/mock-controller.ts'),
      readSource('helper/spawn-capture-helper-client.ts'),
    ]);

    for (const source of sources) {
      expect(source).not.toMatch(/from ['"]\.\.\/runtime\//);
    }
  });

  it('does not retain capture compatibility modules in the runtime capability', async () => {
    const compatibilityModules: string[] = [];
    const glob = new Bun.Glob('runtime/capture-helper-*.ts');

    for await (const relativePath of glob.scan({ cwd: DESKTOP_SOURCE_ROOT })) {
      compatibilityModules.push(relativePath);
    }

    expect(compatibilityModules).toEqual([]);
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
      readSource('auth/session-startup.ts'),
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
      readSource('capture/ipc-handlers.ts'),
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
      readSource('sync/sync-runtime.ts'),
      readSource('sync/ipc-handlers.ts'),
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
      readSource('ipc/handler-registry.ts'),
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

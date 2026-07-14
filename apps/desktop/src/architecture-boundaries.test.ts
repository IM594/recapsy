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

  it('splits SQLite persistence by table ownership while keeping transactions coordinated', async () => {
    const sourceFiles: string[] = [];
    const glob = new Bun.Glob('**/*.ts');
    for await (const relativePath of glob.scan({ cwd: DESKTOP_SOURCE_ROOT })) {
      sourceFiles.push(relativePath);
    }

    const requiredPaths = [
      'storage/memory.ts',
      'storage/memory.test.ts',
      'storage/sqlite/assets.ts',
      'storage/sqlite/bun.ts',
      'storage/sqlite/cache.ts',
      'storage/sqlite/driver.ts',
      'storage/sqlite/migrations.ts',
      'storage/sqlite/node.ts',
      'storage/sqlite/outbox.ts',
      'storage/sqlite/store.ts',
      'storage/sqlite/store.test.ts',
    ];
    const retiredPaths = [
      'storage/memory-store.ts',
      'storage/store.test.ts',
      'storage/bun-driver.ts',
      'storage/node-driver.ts',
      'storage/sqlite-driver.ts',
      'storage/sqlite-store.ts',
      'storage/sqlite-store.test.ts',
    ];
    const violations = [
      ...requiredPaths
        .filter((relativePath) => !sourceFiles.includes(relativePath))
        .map((relativePath) => `${relativePath} is missing`),
      ...retiredPaths
        .filter((relativePath) => sourceFiles.includes(relativePath))
        .map((relativePath) => `${relativePath} is still present`),
    ];

    if (sourceFiles.includes('storage/sqlite/store.ts')) {
      const storeSource = await readSource('storage/sqlite/store.ts');
      for (const dependency of ['./assets', './cache', './migrations', './outbox']) {
        if (!storeSource.includes(`from '${dependency}'`)) {
          violations.push(`storage/sqlite/store.ts does not depend on ${dependency}`);
        }
      }
      for (const responsibility of [
        'createCaptureOutboxEntry',
        'getBackpressureSnapshot',
        'clearWorkspaceCache',
        'clearSignOutCache',
        'BEGIN IMMEDIATE',
      ]) {
        if (!storeSource.includes(responsibility)) {
          violations.push(`storage/sqlite/store.ts does not own ${responsibility}`);
        }
      }
      for (const migrationDetail of [
        'SCHEMA_VERSION',
        'PRAGMA journal_mode',
        'ensureAssetAvailabilityColumns',
        'migrateOutboxJobsToV2',
      ]) {
        if (storeSource.includes(migrationDetail)) {
          violations.push(`storage/sqlite/store.ts still owns ${migrationDetail}`);
        }
      }
    }

    for (const leafPath of [
      'storage/sqlite/assets.ts',
      'storage/sqlite/cache.ts',
      'storage/sqlite/outbox.ts',
    ]) {
      if (!sourceFiles.includes(leafPath)) {
        continue;
      }
      const leafSource = await readSource(leafPath);
      for (const forbiddenDependency of [
        './store',
        '../capture',
        '../sync',
        '../main',
        'BEGIN IMMEDIATE',
        'COMMIT',
        'ROLLBACK',
      ]) {
        if (leafSource.includes(forbiddenDependency)) {
          violations.push(`${leafPath} depends on ${forbiddenDependency}`);
        }
      }
    }

    const packageSource = await readFile(
      path.resolve(DESKTOP_SOURCE_ROOT, '../package.json'),
      'utf8',
    );
    if (!packageSource.includes('"./storage/sqlite/bun"')) {
      violations.push('package export ./storage/sqlite/bun is missing');
    }
    if (packageSource.includes('"./storage/bun-driver"')) {
      violations.push('package export ./storage/bun-driver is still present');
    }

    expect(violations).toEqual([]);
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

  it('retires the adapter-wide operational store repository type', async () => {
    const retiredType = ['Operational', 'Store', 'Repository'].join('');
    const violations: string[] = [];
    const roots = [DESKTOP_SOURCE_ROOT, path.resolve(DESKTOP_SOURCE_ROOT, '..', 'integration')];
    const glob = new Bun.Glob('**/*.ts');

    for (const root of roots) {
      for await (const relativePath of glob.scan({ cwd: root })) {
        if (root === DESKTOP_SOURCE_ROOT && relativePath === 'architecture-boundaries.test.ts') {
          continue;
        }

        const source = await readFile(path.resolve(root, relativePath), 'utf8');
        if (source.includes(retiredType)) {
          const scope = root === DESKTOP_SOURCE_ROOT ? 'src' : 'integration';
          violations.push(`${scope}/${relativePath} still references the retired repository type`);
        }
      }
    }

    for (const relativePath of [
      'storage/types.ts',
      'storage/index.ts',
      'storage/public.ts',
      'index.ts',
    ]) {
      const source = await readSource(relativePath);
      if (source.includes(retiredType)) {
        violations.push(`${relativePath} still exports the retired repository type`);
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

  it('uses worker naming for sync claim and cancellation orchestration', async () => {
    const sourceFiles: string[] = [];
    const sources: string[] = [];
    const roots = [DESKTOP_SOURCE_ROOT, path.resolve(DESKTOP_SOURCE_ROOT, '../integration')];
    const glob = new Bun.Glob('**/*.ts');

    for (const root of roots) {
      for await (const relativePath of glob.scan({ cwd: root })) {
        const scopedPath =
          root === DESKTOP_SOURCE_ROOT ? `src/${relativePath}` : `integration/${relativePath}`;
        sourceFiles.push(scopedPath);
        if (scopedPath === 'src/architecture-boundaries.test.ts') {
          continue;
        }
        sources.push(await readFile(path.join(root, relativePath), 'utf8'));
      }
    }

    const source = sources.join('\n');
    const violations: string[] = [];
    for (const requiredPath of ['src/sync/worker.ts', 'src/sync/worker.test.ts']) {
      if (!sourceFiles.includes(requiredPath)) {
        violations.push(`${requiredPath} is missing`);
      }
    }
    for (const retiredPath of ['src/sync/scheduler.ts', 'src/sync/scheduler.test.ts']) {
      if (sourceFiles.includes(retiredPath)) {
        violations.push(`${retiredPath} is still present`);
      }
    }
    for (const retiredSymbol of [
      'createSyncScheduler',
      'SyncSchedulerOptions',
      'SyncSchedulerStore',
    ]) {
      if (new RegExp(`\\b${retiredSymbol}\\b`).test(source)) {
        violations.push(`${retiredSymbol} is still referenced`);
      }
    }
    if (/\bscheduler\b/i.test(source)) {
      violations.push('scheduler naming is still referenced');
    }

    expect(violations).toEqual([]);
  });

  it('keeps the sync worker independent from IPC and concrete server errors', async () => {
    const source = await readSource('sync/worker.ts');

    expect(source).not.toMatch(/from ['"]\.\.\/ipc/);
    expect(source).not.toMatch(/from ['"]\.\.\/server/);
    expect(source).not.toContain('ServerApiError');
  });

  it('gives the single-job sync state machine its own executor', async () => {
    const [workerSource, runtimeSource] = await Promise.all([
      readSource('sync/worker.ts'),
      readSource('sync/runtime.ts'),
    ]);
    const sourceFiles: string[] = [];
    const glob = new Bun.Glob('**/*.ts');
    for await (const relativePath of glob.scan({ cwd: DESKTOP_SOURCE_ROOT })) {
      sourceFiles.push(relativePath);
    }

    const violations: string[] = [];
    for (const requiredPath of ['sync/job.ts', 'sync/job.test.ts']) {
      if (!sourceFiles.includes(requiredPath)) {
        violations.push(`${requiredPath} is missing`);
      }
    }

    if (sourceFiles.includes('sync/job.ts')) {
      const jobSource = await readSource('sync/job.ts');
      for (const requiredPort of ['SyncJobApi', 'SyncJobStore', 'SyncJobExecutor']) {
        if (!new RegExp(`export\\s+(?:interface|type)\\s+${requiredPort}\\b`).test(jobSource)) {
          violations.push(`sync/job.ts does not export ${requiredPort}`);
        }
      }
      if (!/export\s+function\s+createSyncJobExecutor\b/.test(jobSource)) {
        violations.push('sync/job.ts does not export createSyncJobExecutor');
      }
      for (const policyModule of ['errors', 'reconciliation', 'retry', 'screen-text']) {
        if (!new RegExp(`from\\s+['"]\\./${policyModule}['"]`).test(jobSource)) {
          violations.push(`sync/job.ts does not reuse ./${policyModule}`);
        }
      }
      for (const forbiddenWorkerResponsibility of [
        'SyncQueueStore',
        'OperationalStoreRepository',
        'claimNextRetryableOutboxJob',
        'recoverInterruptedOutboxJob',
        'listOutboxJobs',
        'backpressure',
      ]) {
        if (new RegExp(`\\b${forbiddenWorkerResponsibility}\\b`).test(jobSource)) {
          violations.push(
            `sync/job.ts owns worker responsibility ${forbiddenWorkerResponsibility}`,
          );
        }
      }
    }

    if (!/from\s+['"]\.\/job['"]/.test(workerSource)) {
      violations.push('sync/worker.ts does not depend on the job executor');
    }
    if (!/export\s+type\s+SyncWorkerStore\b/.test(workerSource)) {
      violations.push('sync/worker.ts does not own SyncWorkerStore');
    }
    for (const workerStoreMethod of [
      'claimNextRetryableOutboxJob',
      'getOutboxJob',
      'markOutboxJobTerminal',
    ]) {
      if (!new RegExp(`\\b${workerStoreMethod}\\s*\\(`).test(workerSource)) {
        violations.push(`SyncWorkerStore does not declare ${workerStoreMethod}`);
      }
    }
    if (!/\bexecuteJob\s*\(\s*job\s*\)/.test(workerSource)) {
      violations.push('sync/worker.ts does not delegate a claimed job to executeJob');
    }
    for (const retiredJobImplementation of [
      'syncJob',
      'submitStoredOcrResult',
      'handleSyncError',
      'markJobTerminalWithSafeError',
      'ensureWorkspaceStillActive',
      'recordSafeError',
      'isLocallyCancelled',
      'ingestCapture',
      'runOcrProxy',
      'submitOcrResult',
      'getAssetCacheRef',
      'recordOutboxSafeError',
      'computeRetryBackoffDelayMs',
      'classifySyncError',
      'mapOcrScreenText',
      'reconcileOutboxJobFromServerCapture',
      'SyncQueueStore',
      'OperationalStoreRepository',
      'SyncServerApi',
      'SyncAssetReader',
      'readAssetBytes',
      'retryBackoff',
    ]) {
      if (new RegExp(`\\b${retiredJobImplementation}\\b`).test(workerSource)) {
        violations.push(`sync/worker.ts still owns ${retiredJobImplementation}`);
      }
    }

    if (
      !/import\s*\{[^}]*\bcreateSyncJobExecutor\b[^}]*\}\s*from\s*['"]\.\/job['"]/s.test(
        runtimeSource,
      )
    ) {
      violations.push('sync/runtime.ts does not compose createSyncJobExecutor');
    }

    expect(violations).toEqual([]);
  });

  it('gives retry policy its own sync module and test ownership', async () => {
    const [jobSource, publicSource] = await Promise.all([
      readSource('sync/job.ts'),
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
    if (/export function computeRetryBackoffDelayMs\s*\(/.test(jobSource)) {
      violations.push('sync/job.ts still declares computeRetryBackoffDelayMs');
    }
    if (
      !/import\s*\{[^}]*\bcomputeRetryBackoffDelayMs\b[^}]*\}\s*from\s*['"]\.\/retry['"]/s.test(
        jobSource,
      )
    ) {
      violations.push('sync/job.ts does not import computeRetryBackoffDelayMs from ./retry');
    }
    if (
      !/export\s*\{[^}]*\bcomputeRetryBackoffDelayMs\b[^}]*\}\s*from\s*['"]\.\/retry['"]/s.test(
        publicSource,
      )
    ) {
      violations.push('sync/public.ts does not export computeRetryBackoffDelayMs from ./retry');
    }
    if (
      /export\s*\{[^}]*\bcomputeRetryBackoffDelayMs\b[^}]*\}\s*from\s*['"]\.\/worker['"]/s.test(
        publicSource,
      )
    ) {
      violations.push('sync/public.ts still exports computeRetryBackoffDelayMs from ./worker');
    }

    expect(violations).toEqual([]);
  });

  it('owns sync error classification and safe presentation in one module', async () => {
    const jobSource = await readSource('sync/job.ts');
    const sourceFiles: string[] = [];
    const glob = new Bun.Glob('**/*.ts');
    for await (const relativePath of glob.scan({ cwd: DESKTOP_SOURCE_ROOT })) {
      sourceFiles.push(relativePath);
    }

    const violations: string[] = [];
    for (const requiredPath of ['sync/errors.ts', 'sync/errors.test.ts']) {
      if (!sourceFiles.includes(requiredPath)) {
        violations.push(`${requiredPath} is missing`);
      }
    }
    const expectedImports = [
      'classifySyncError',
      'isLocalAssetSyncErrorCode',
      'isTerminalBlockingSyncErrorCode',
      'syncSafeMessage',
    ];
    const errorsImport = jobSource.match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/errors['"]/s)?.[1];
    for (const expectedImport of expectedImports) {
      if (!errorsImport || !new RegExp(`\\b${expectedImport}\\b`).test(errorsImport)) {
        violations.push(`sync/job.ts does not import ${expectedImport} from ./errors`);
      }
    }

    for (const retiredDeclaration of [
      'TERMINAL_BLOCKING_OCR_ERRORS',
      'classifyUnhandledSyncError',
      'isSafeErrorShape',
      'isClassifiableSyncErrorCode',
      'isRetryableClassifiableSyncCode',
      'toPresentationErrorCode',
      'toIpcError',
      'syncSafeMessage',
      'isLocalAssetSafeCode',
    ]) {
      if (new RegExp(`(?:const|function)\\s+${retiredDeclaration}\\b`).test(jobSource)) {
        violations.push(`sync/job.ts still declares ${retiredDeclaration}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('owns sync queue summary projection in a narrow read module', async () => {
    const [workerSource, publicSource, handlersSource] = await Promise.all([
      readSource('sync/worker.ts'),
      readSource('sync/public.ts'),
      readSource('sync/handlers.ts'),
    ]);
    const sourceFiles: string[] = [];
    const glob = new Bun.Glob('**/*.ts');
    for await (const relativePath of glob.scan({ cwd: DESKTOP_SOURCE_ROOT })) {
      sourceFiles.push(relativePath);
    }

    const violations: string[] = [];
    for (const requiredPath of ['sync/summary.ts', 'sync/summary.test.ts']) {
      if (!sourceFiles.includes(requiredPath)) {
        violations.push(`${requiredPath} is missing`);
      }
    }

    if (sourceFiles.includes('sync/summary.ts')) {
      const summarySource = await readSource('sync/summary.ts');
      if (!/export\s+(?:interface|type)\s+SyncSummaryStore\b/.test(summarySource)) {
        violations.push('sync/summary.ts does not export SyncSummaryStore');
      }
      if (!/\blistOutboxJobs\s*\(/.test(summarySource)) {
        violations.push('SyncSummaryStore does not declare listOutboxJobs');
      }
      for (const forbiddenDependency of [
        'SyncQueueStore',
        'OperationalStoreRepository',
        'claimNextRetryableOutboxJob',
        'getOutboxJob',
        'recordOutboxSafeError',
        'updateOutboxJobState',
      ]) {
        if (new RegExp(`\\b${forbiddenDependency}\\b`).test(summarySource)) {
          violations.push(`sync/summary.ts still depends on ${forbiddenDependency}`);
        }
      }
      if (
        !/import\s*\{[^}]*\btoSyncPresentationError\b[^}]*\}\s*from\s*['"]\.\/errors['"]/s.test(
          summarySource,
        )
      ) {
        violations.push('sync/summary.ts does not import toSyncPresentationError from ./errors');
      }
    }

    if (/\bcreateSyncQueueSummary\b/.test(workerSource)) {
      violations.push('sync/worker.ts still owns createSyncQueueSummary');
    }
    if (
      !/export\s*\{[^}]*\bcreateSyncQueueSummary\b[^}]*\}\s*from\s*['"]\.\/summary['"]/s.test(
        publicSource,
      )
    ) {
      violations.push('sync/public.ts does not export createSyncQueueSummary from ./summary');
    }
    if (
      !/export\s+type\s*\{[^}]*\bSyncSummaryStore\b[^}]*\}\s*from\s*['"]\.\/summary['"]/s.test(
        publicSource,
      )
    ) {
      violations.push('sync/public.ts does not export SyncSummaryStore from ./summary');
    }
    if (
      /export\s*\{[^}]*\bcreateSyncQueueSummary\b[^}]*\}\s*from\s*['"]\.\/worker['"]/s.test(
        publicSource,
      )
    ) {
      violations.push('sync/public.ts still exports createSyncQueueSummary from ./worker');
    }
    if (
      !/import\s*\{[^}]*\bcreateSyncQueueSummary\b[^}]*\}\s*from\s*['"]\.\/summary['"]/s.test(
        handlersSource,
      )
    ) {
      violations.push('sync/handlers.ts does not import createSyncQueueSummary from ./summary');
    }
    if (!/\bSyncSummaryStore\b/.test(handlersSource)) {
      violations.push('sync/handlers.ts does not depend on SyncSummaryStore');
    }
    if (/\bSyncQueueStore\b/.test(handlersSource)) {
      violations.push('sync/handlers.ts still depends on SyncQueueStore');
    }

    expect(violations).toEqual([]);
  });

  it('separates server-capture reconciliation from storage asset reconciliation', async () => {
    const [jobSource, recoverySource, publicSource] = await Promise.all([
      readSource('sync/job.ts'),
      readSource('sync/recovery.ts'),
      readSource('sync/public.ts'),
    ]);
    const sourceFiles: string[] = [];
    const glob = new Bun.Glob('**/*.ts');
    for await (const relativePath of glob.scan({ cwd: DESKTOP_SOURCE_ROOT })) {
      sourceFiles.push(relativePath);
    }

    const violations: string[] = [];
    for (const requiredPath of [
      'sync/reconciliation.ts',
      'sync/reconciliation.test.ts',
      'storage/reconciliation.ts',
      'storage/reconciliation.test.ts',
    ]) {
      if (!sourceFiles.includes(requiredPath)) {
        violations.push(`${requiredPath} is missing`);
      }
    }

    if (sourceFiles.includes('sync/reconciliation.ts')) {
      const reconciliationSource = await readSource('sync/reconciliation.ts');
      for (const port of [
        'ServerCaptureReconciliationApi',
        'ServerCaptureReconciliationStore',
        'ServerCaptureReconciliationClock',
      ]) {
        if (!new RegExp(`export\\s+(?:interface|type)\\s+${port}\\b`).test(reconciliationSource)) {
          violations.push(`sync/reconciliation.ts does not export ${port}`);
        }
      }
      for (const forbiddenDependency of [
        'SyncQueueStore',
        'SyncWorkerOptions',
        'OperationalStoreRepository',
        'claimNextRetryableOutboxJob',
        'getAssetCacheRef',
        'getOutboxJob',
        'recordOutboxSafeError',
        'recoverInterruptedOutboxJob',
        'updateOutboxJobState',
        'AssetCacheRef',
        'AssetAvailabilityResolver',
        'reconcileAssetRefs',
      ]) {
        if (new RegExp(`\\b${forbiddenDependency}\\b`).test(reconciliationSource)) {
          violations.push(`sync/reconciliation.ts still depends on ${forbiddenDependency}`);
        }
      }
    }

    for (const [consumerPath, source] of [
      ['sync/job.ts', jobSource],
      ['sync/recovery.ts', recoverySource],
    ] as const) {
      if (
        !/import\s*\{[^}]*\breconcileOutboxJobFromServerCapture\b[^}]*\}\s*from\s*['"]\.\/reconciliation['"]/s.test(
          source,
        )
      ) {
        violations.push(
          `${consumerPath} does not import reconcileOutboxJobFromServerCapture from ./reconciliation`,
        );
      }
    }
    if (/export\s+async\s+function\s+reconcileOutboxJobFromServerCapture\b/.test(jobSource)) {
      violations.push('sync/job.ts still declares reconcileOutboxJobFromServerCapture');
    }
    if (
      !/export\s*\{[^}]*\breconcileOutboxJobFromServerCapture\b[^}]*\}\s*from\s*['"]\.\/reconciliation['"]/s.test(
        publicSource,
      )
    ) {
      violations.push(
        'sync/public.ts does not export reconcileOutboxJobFromServerCapture from ./reconciliation',
      );
    }
    if (
      !/export\s+type\s*\{[^}]*(?:\bServerCaptureReconciliationApi\b|\bServerCaptureReconciliationStore\b|\bServerCaptureReconciliationClock\b)[^}]*\}\s*from\s*['"]\.\/reconciliation['"]/s.test(
        publicSource,
      )
    ) {
      violations.push('sync/public.ts does not export server-capture reconciliation ports');
    }
    if (
      /export\s*\{[^}]*\breconcileOutboxJobFromServerCapture\b[^}]*\}\s*from\s*['"]\.\/worker['"]/s.test(
        publicSource,
      )
    ) {
      violations.push(
        'sync/public.ts still exports reconcileOutboxJobFromServerCapture from ./worker',
      );
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
      'storage/sqlite/store.ts',
      'storage/memory.ts',
      'storage/sqlite/node.ts',
      'storage/sqlite/bun.ts',
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

  it('gives sync ownership of recovery, worker, loop startup, and queue IPC', async () => {
    const [runtimeSource, syncRuntimeSource, syncHandlersSource] = await Promise.all([
      readSource('main/runtime.ts'),
      readSource('sync/runtime.ts'),
      readSource('sync/handlers.ts'),
    ]);

    expect(runtimeSource).not.toContain('createSyncWorker');
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

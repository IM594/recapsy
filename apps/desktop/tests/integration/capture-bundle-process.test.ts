import { afterEach, describe, expect, it } from 'bun:test';
import { type ChildProcess, execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileCapturePolicy, createCapturePolicyController } from '../../src/capture/index';
import {
  type CaptureHelperTransportEvent,
  HELPER_PROTOCOL_VERSION,
  type HelperEnvelope,
  type HelperToMainType,
  createHelperProcessClient,
} from '../../src/helper/index';
import productIdentity from '../../src/product-identity.json';
import { createServerApiClient } from '../../src/server/index';
import { createSqliteStore } from '../../src/storage/index';
import { createBunSqliteDatabase } from '../../src/storage/sqlite/bun';

/**
 * Real cross-process test of the *signed Swift capture bundle*, spawned exactly
 * the way Electron will spawn it in production (ADR 0009):
 *   command = the disclaim launcher inside the bundle
 *   args    = [ the capture executable inside the bundle ]
 *   env     = RECAPSY_CAPTURE_ASSET_ROOT pointing at a real directory
 *
 * What this asserts honestly:
 *   - the launcher really posix_spawns the capture binary and the NDJSON
 *     handshake crosses the process boundary (`helper.hello` with
 *     `mock === false` — this is the real helper, not the dev stand-in);
 *   - the capture loop reports permission state and a capture-shaped envelope;
 *   - `stop()` makes the launcher (and the capture process it waits on) exit
 *     cleanly with no zombie.
 *
 * What it deliberately does NOT assert: a real screenshot reaching the server.
 * The bundle id `one.recapsy.desktop.capture` is a brand-new TCC identity that
 * only the user can grant screen-recording to in System Settings; that path is
 * covered by the manual E2E checklist in `macos/README.md`, never faked here.
 */
const desktopRoot = fileURLToPath(new URL('../../', import.meta.url));
const captureBundle = resolveCaptureBundlePath(process.env.RECAPSY_CAPTURE_BUNDLE);
const launcherPath = path.join(captureBundle.path, 'Contents', 'MacOS', 'CaptureLauncher');
const captureBinaryPath = path.join(
  captureBundle.path,
  'Contents',
  'MacOS',
  productIdentity.captureExecutableName,
);
const launcherSourcePath = fileURLToPath(
  new URL('../../macos/Sources/CaptureLauncher/main.c', import.meta.url),
);
const webpProvenancePath = path.join(desktopRoot, 'macos', 'build', 'libwebp-arm64.json');

const bundleBuilt = validateCaptureBundleAvailability(captureBundle);
if (!bundleBuilt) {
  throw new Error(
    'capture bundle not found — run `pnpm run build:capture` before running bundle process tests.',
  );
}
const bundleIt = it;

const activeChildren: ChildProcess[] = [];
const activeCaptureProcessIds = new Set<number>();
const activeFileDescriptors: number[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  for (const child of activeChildren.splice(0)) {
    if (isProcessAlive(child.pid)) {
      child.kill('SIGKILL');
    }
  }
  for (const processId of activeCaptureProcessIds) {
    if (isProcessAlive(processId)) {
      process.kill(processId, 'SIGKILL');
    }
  }
  activeCaptureProcessIds.clear();
  for (const fileDescriptor of activeFileDescriptors.splice(0)) {
    closeSync(fileDescriptor);
  }
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
  await delay(20);
});

describe('capture bundle subprocess (real signed Swift bundle via disclaim launcher)', () => {
  bundleIt('links pinned arm64 libwebp archives built for macOS 14', () => {
    expect(existsSync(webpProvenancePath)).toBe(true);
    const provenance = JSON.parse(
      readFileSync(webpProvenancePath, 'utf8'),
    ) as LibwebpBuildProvenance;

    expect(provenance).toMatchObject({
      architecture: 'arm64',
      deploymentTarget: '14.0',
      sourceSha256: 'e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564',
      version: '1.6.0',
    });
    for (const archivePath of [provenance.libsharpyuvArchive, provenance.libwebpArchive]) {
      expect(readArchitectures(archivePath)).toEqual(['arm64']);
      expect(readMinimumMacOSVersions(archivePath)).toEqual(['14.0']);
    }
  });

  it('uses the explicitly configured capture bundle for both spawned executables', () => {
    if (captureBundle.selection !== 'configured') {
      return;
    }

    expect(path.relative(captureBundle.path, launcherPath)).toBe(
      path.join('Contents', 'MacOS', 'CaptureLauncher'),
    );
    expect(path.relative(captureBundle.path, captureBinaryPath)).toBe(
      path.join('Contents', 'MacOS', productIdentity.captureExecutableName),
    );
  });

  bundleIt('receives a real helper.hello with mock=false through the launcher', async () => {
    const { client, envelopes } = startBundleClient();

    const hello = await waitForEnvelope(envelopes, 'helper.hello');

    expect(hello.payload.capabilities.mock).toBe(false);
    expect(hello.payload.capabilities.capture).toBe(true);
    expect(hello.payload.capabilities.permissions).toBe(true);
    expect(typeof hello.payload.pid).toBe('number');

    await client.stop();
  });

  bundleIt('reports screen-recording permission state', async () => {
    const { client, envelopes } = startBundleClient();
    await waitForEnvelope(envelopes, 'helper.hello');

    const permission = await waitForEnvelope(envelopes, 'permission.status');
    expect(['granted', 'denied', 'not_determined', 'unknown']).toContain(
      permission.payload.screenCapture,
    );
    // Accessibility is probed by the real capture process; accept either
    // granted (already trusted) or not_determined (needs System Settings).
    expect(['granted', 'not_determined']).toContain(permission.payload.accessibility);

    await client.stop();
  });

  bundleIt(
    'rejects a policy whose declared hash does not match its executable content',
    async () => {
      const { client, envelopes } = startBundleClient();
      await waitForEnvelope(envelopes, 'helper.hello');
      const validPolicy = capturePolicy();

      await client.sendCommand({
        correlationId: 'tampered-policy-1',
        messageId: 'test-tampered-policy-1',
        payload: {
          captureIdentity: { deviceId: 'device_1', workspaceId: 'workspace_1' },
          policy: {
            ...validPolicy,
            policyHash: `sha256:${'f'.repeat(64)}`,
          },
        },
        protocolVersion: HELPER_PROTOCOL_VERSION,
        sentAt: new Date().toISOString(),
        type: 'helper.configure',
      });

      await waitForEnvelope(
        envelopes,
        'helper.status',
        (envelope) =>
          envelope.payload.status === 'paused' && envelope.payload.reason === 'policy_unavailable',
      );
      expect(
        envelopes.filter((envelope) => envelope.type === 'helper.policy_applied'),
      ).toHaveLength(0);

      await client.stop();
    },
  );

  bundleIt(
    'composes policy GET, SQLite cache, compiler, real helper ACK, and capture start',
    async () => {
      const workspaceId = '00000000-0000-4000-8000-000000000001';
      const deviceId = '00000000-0000-4000-8000-000000000002';
      const now = '2026-07-18T00:00:00.000Z';
      const { assetRoot, client, envelopes } = startBundleClient();
      const store = createSqliteStore({
        database: createBunSqliteDatabase(path.join(assetRoot, 'profile.sqlite')),
      });

      try {
        await store.initialize();
        await waitForEnvelope(envelopes, 'helper.hello');
        const requests: Array<{ method: string; path: string; query: Record<string, string> }> = [];
        const api = createServerApiClient({
          accessTokenProvider: {
            async getAccessToken() {
              return 'composition-access-token';
            },
          },
          endpoint: 'https://api.example.test',
          async transport(request) {
            requests.push({ method: request.method, path: request.path, query: request.query });
            return {
              body: capturePoliciesHttpResponse(workspaceId, deviceId, now),
              status: 200,
            };
          },
        });
        const policy = createCapturePolicyController({
          api,
          configure: (capturePolicy, identity) => client.configureCapture(capturePolicy, identity),
          deviceId,
          now: () => now,
          store,
          workspaceId,
        });

        const configuration = await policy.activate();
        const cached = await store.getPolicyCache(workspaceId, deviceId, { now });
        expect(requests).toEqual([
          {
            method: 'GET',
            path: '/v1/capture/policies',
            query: { deviceId, workspaceId },
          },
        ]);
        expect(cached).toMatchObject({
          expired: false,
          policySnapshotId: '00000000-0000-4000-8000-000000000003',
          policyVersion: 'composition-policy-v1',
        });
        expect(configuration.policy.policyHash).toMatch(/^sha256:[a-f0-9]{64}$/);

        await waitForEnvelope(
          envelopes,
          'helper.policy_applied',
          (envelope) => envelope.payload.policyHash === configuration.policy.policyHash,
        );
        await client.beginCapture('runtime_started');
        await waitForEnvelope(
          envelopes,
          'helper.status',
          (envelope) => envelope.payload.status === 'ready',
        );
      } finally {
        store.close();
        await client.stop();
      }
    },
  );

  bundleIt(
    'runs the capture loop after start and emits a protocol-valid capture envelope (or skips cleanly with no active window)',
    async () => {
      const { client, envelopes } = startBundleClient();
      await waitForEnvelope(envelopes, 'helper.hello');
      const heartbeatsBeforeStart = countEnvelopes(envelopes, 'helper.heartbeat');

      await client.configureCapture(capturePolicy(), {
        deviceId: 'device_1',
        workspaceId: 'workspace_1',
      });
      const policyApplied = await waitForEnvelope(envelopes, 'helper.policy_applied');
      expect(policyApplied.payload).toEqual({
        policyHash: capturePolicy().policyHash,
        policyVersion: capturePolicy().version,
      });

      // Drive the capture loop by sending the real `capture.start` command the
      // Electron runtime sends; the engine then begins its cadence.
      await client.sendCommand({
        correlationId: null,
        messageId: 'test-capture-start-1',
        payload: { reason: 'runtime_started' },
        protocolVersion: HELPER_PROTOCOL_VERSION,
        sentAt: new Date().toISOString(),
        type: 'capture.start',
      });
      // Drive a few capture ticks. Three honest outcomes, all accepted:
      //   - capture.result  : a granted screen-recording + a capturable active
      //     window → a real WebP asset envelope;
      //   - capture.error   : e.g. permission_missing for this new bundle id;
      //   - nothing         : the foreground app has no capturable window (very
      //     common in a headless/non-interactive test session), so the engine
      //     deliberately skips the tick and emits no capture envelope — by
      //     design it invents no protocol reason for this.
      const captureLike = await waitForAnyEnvelopeOrNull(
        envelopes,
        ['capture.result', 'capture.error'],
        4500,
      );

      if (captureLike?.type === 'capture.error') {
        expect(['permission_missing', 'capture_failed', 'asset_write_failed']).toContain(
          (captureLike as HelperEnvelope<'capture.error'>).payload.code,
        );
      } else if (captureLike?.type === 'capture.result') {
        const result = captureLike as HelperEnvelope<'capture.result'>;
        expect(result.payload.assets[0]?.role).toBe('screenshot');
        expect(result.payload.assets[0]?.ref).toMatch(/^cap-[0-9]+-[0-9]+\/screenshot\.webp$/);
        expect(result.payload.assets[0]?.mimeType).toBe('image/webp');
        expect(result.payload.assets[0]?.sizeBytes ?? 0).toBeGreaterThan(0);
      } else {
        // No capture envelope: assert the loop is alive and still ticking
        // (heartbeats advanced) rather than hung or crashed — a real skip, not
        // a stall.
        expect(countEnvelopes(envelopes, 'helper.heartbeat')).toBeGreaterThan(
          heartbeatsBeforeStart,
        );
      }

      await client.stop();
    },
    15000,
  );

  bundleIt(
    'replays a durable receipt after helper restart and removes only the receipt on ACK',
    async () => {
      const captureId = 'cap-recovered-1';
      const { assetRoot, client, envelopes } = startBundleClient();
      const bytes = Buffer.from('recovered-screen-bytes');
      const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const captureDirectory = path.join(assetRoot, captureId);
      const screenshotPath = path.join(captureDirectory, 'screenshot.webp');
      const receiptPath = path.join(captureDirectory, 'capture.receipt.json');
      mkdirSync(captureDirectory, { recursive: true });
      writeFileSync(screenshotPath, bytes);
      writeFileSync(
        receiptPath,
        JSON.stringify({
          captureId,
          capturedAt: '2026-07-18T00:00:00.100Z',
          decision: 'allow',
          deviceId: 'device_1',
          frameQuality: { luminanceBucket: 8, marginal: false },
          observedAt: '2026-07-18T00:00:00.000Z',
          policy: { hash: capturePolicy().policyHash, version: 'bundle-policy-1' },
          schemaVersion: 3,
          screenshot: {
            hash,
            mimeType: 'image/webp',
            ref: `${captureId}/screenshot.webp`,
            sizeBytes: bytes.length,
          },
          source: {
            application: { bundleId: 'one.recapsy.fixture', name: 'Fixture App' },
            ownerProcessId: 4242,
            windowId: 42,
          },
          workspaceId: 'workspace_1',
        }),
      );
      expect(existsSync(receiptPath)).toBe(true);

      await waitForEnvelope(envelopes, 'helper.hello');
      await client.configureCapture(capturePolicy(), {
        deviceId: 'device_1',
        workspaceId: 'workspace_1',
      });
      const recoveredOrError = await waitForAnyEnvelopeOrNull(
        envelopes,
        ['capture.result', 'capture.error'],
        1000,
      );
      if (!recoveredOrError || recoveredOrError.type !== 'capture.result') {
        throw new Error(
          `Receipt recovery envelopes: ${envelopes.map((item) => item.type).join(',')}`,
        );
      }
      const recovered = recoveredOrError as HelperEnvelope<'capture.result'>;
      expect(recovered.payload.captureId).toBe(captureId);
      expect(readFileSync(screenshotPath)).toEqual(bytes);

      await client.sendCommand({
        correlationId: recovered.messageId,
        messageId: 'test-recovery-ack-1',
        payload: { captureId },
        protocolVersion: HELPER_PROTOCOL_VERSION,
        sentAt: new Date().toISOString(),
        type: 'capture.ack',
      });
      await waitForCondition(() => !existsSync(receiptPath), 1000);
      expect(existsSync(screenshotPath)).toBe(true);
      await client.stop();
    },
  );

  bundleIt('stop() exits the launcher and capture process with no zombie', async () => {
    const { client, envelopes, child, events } = startBundleClient();
    await waitForEnvelope(envelopes, 'helper.hello');

    await client.stop();
    await waitForCondition(() => !isProcessAlive(child.pid), 4000);

    expect(isProcessAlive(child.pid)).toBe(false);
    expect(events.filter((event) => event.type === 'process_exit')).toHaveLength(0);
  });

  bundleIt(
    'forwards SIGTERM to the supervised capture process',
    async () => {
      const { child, envelopes } = startBundleClient({ keepStdinOpen: true });
      const hello = await waitForEnvelope(envelopes, 'helper.hello');
      const captureProcessId = requireCaptureProcessId(hello.payload.pid);
      activeCaptureProcessIds.add(captureProcessId);

      expect(child.kill('SIGTERM')).toBe(true);
      await waitForCondition(() => !isProcessAlive(child.pid), 4000);
      await waitForCondition(() => !isProcessAlive(captureProcessId), 4000);

      expect(isProcessAlive(captureProcessId)).toBe(false);
    },
    10000,
  );

  bundleIt(
    'forwards SIGINT to the supervised capture process',
    async () => {
      const { child, envelopes } = startBundleClient({ keepStdinOpen: true });
      const hello = await waitForEnvelope(envelopes, 'helper.hello');
      const captureProcessId = requireCaptureProcessId(hello.payload.pid);
      activeCaptureProcessIds.add(captureProcessId);

      expect(child.kill('SIGINT')).toBe(true);
      await waitForCondition(() => !isProcessAlive(child.pid), 4000);
      await waitForCondition(() => !isProcessAlive(captureProcessId), 4000);

      expect(isProcessAlive(captureProcessId)).toBe(false);
    },
    10000,
  );

  bundleIt(
    'force-stop kills the dedicated launcher process group with no capture orphan',
    async () => {
      const { child, client, envelopes } = startBundleClient({
        keepStdinOpen: true,
        shutdownTimeoutMs: 20,
      });
      const hello = await waitForEnvelope(envelopes, 'helper.hello');
      const captureProcessId = requireCaptureProcessId(hello.payload.pid);
      activeCaptureProcessIds.add(captureProcessId);

      await client.stop();
      await waitForCondition(() => !isProcessAlive(child.pid), 4000);
      await waitForCondition(() => !isProcessAlive(captureProcessId), 4000);

      expect(isProcessAlive(captureProcessId)).toBe(false);
    },
    10000,
  );
});

describe('capture launcher supervision invariants', () => {
  const source = readFileSync(launcherSourcePath, 'utf8');

  it('installs SIGTERM and SIGINT handlers that signal the supervised child', () => {
    expect(source).toContain('install_signal_handler(SIGTERM)');
    expect(source).toContain('install_signal_handler(SIGINT)');
    expect(source).toMatch(/kill\([^,]+, signal_number\)/);
  });

  it('retries waitpid only when it is interrupted', () => {
    expect(source).toMatch(/wait_result < 0 && errno == EINTR/);
  });
});

function startBundleClient(options: { keepStdinOpen?: boolean; shutdownTimeoutMs?: number } = {}): {
  assetRoot: string;
  child: ChildProcess;
  client: ReturnType<typeof createHelperProcessClient>;
  envelopes: HelperEnvelope<HelperToMainType>[];
  events: CaptureHelperTransportEvent[];
} {
  const assetRoot = mkdtempSync(path.join(tmpdir(), 'recapsy-capture-assets-'));
  tempRoots.push(assetRoot);

  let capturedChild: ChildProcess | undefined;
  const client = createHelperProcessClient({
    args: [captureBinaryPath],
    command: launcherPath,
    env: { RECAPSY_CAPTURE_ASSET_ROOT: assetRoot },
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 3000,
    spawnHelperProcess: (command, args, spawnOptions) => {
      let stdin: number | 'pipe' = 'pipe';
      if (options.keepStdinOpen) {
        const fifoPath = path.join(assetRoot, 'capture-stdin.fifo');
        execFileSync('/usr/bin/mkfifo', [fifoPath]);
        stdin = openSync(fifoPath, constants.O_RDWR);
        activeFileDescriptors.push(stdin);
      }
      const child = nodeSpawn(command, args, {
        detached: spawnOptions.detached,
        env: spawnOptions.env,
        stdio: [stdin, 'pipe', 'pipe'],
      });
      capturedChild = child;
      activeChildren.push(child);
      return child;
    },
  });

  const envelopes: HelperEnvelope<HelperToMainType>[] = [];
  const events: CaptureHelperTransportEvent[] = [];
  const startPromise = client.start({
    async handle(event) {
      if (event.type === 'envelope') envelopes.push(event.envelope);
      else events.push(event);
    },
  });

  void startPromise.catch((error: unknown) => {
    console.error('capture bundle client failed to start', error);
  });

  if (!capturedChild) {
    throw new Error('capture bundle subprocess was not spawned synchronously');
  }

  return { assetRoot, child: capturedChild, client, envelopes, events };
}

function waitForEnvelope<TType extends HelperToMainType>(
  envelopes: HelperEnvelope<HelperToMainType>[],
  type: TType,
  predicate: (envelope: HelperEnvelope<TType>) => boolean = () => true,
  timeoutMs = 4000,
): Promise<HelperEnvelope<TType>> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const match = envelopes.find(
        (envelope): envelope is HelperEnvelope<TType> =>
          envelope.type === type && predicate(envelope as HelperEnvelope<TType>),
      );
      if (match) {
        resolve(match);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for envelope of type "${type}".`));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function waitForAnyEnvelopeOrNull(
  envelopes: HelperEnvelope<HelperToMainType>[],
  types: HelperToMainType[],
  timeoutMs: number,
): Promise<HelperEnvelope<HelperToMainType> | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const match = envelopes.find((envelope) => types.includes(envelope.type));
      if (match) {
        resolve(match);
        return;
      }
      if (Date.now() > deadline) {
        resolve(null);
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function countEnvelopes(
  envelopes: HelperEnvelope<HelperToMainType>[],
  type: HelperToMainType,
): number {
  return envelopes.filter((envelope) => envelope.type === type).length;
}

function waitForCondition(predicate: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('Timed out waiting for condition.'));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function requireCaptureProcessId(processId: number | null): number {
  if (!processId) {
    throw new Error('real capture process did not report its pid');
  }
  return processId;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function capturePolicy() {
  return compileCapturePolicy({
    policy: {
      axTextUploadEnabled: false,
      defaultAction: 'allow',
      paused: false,
      rules: [],
    },
    version: 'bundle-policy-1',
  });
}

function capturePoliciesHttpResponse(workspaceId: string, deviceId: string, generatedAt: string) {
  return {
    axAllowlist: {
      axTextUploadEnabled: false,
      enabled: false,
      reason: 'ax_text_upload_disabled',
      status: 'disabled',
    },
    capturePolicy: {
      deviceId,
      expiresAt: '2026-07-18T06:00:00.000Z',
      generatedAt,
      id: '00000000-0000-4000-8000-000000000003',
      policy: {
        axTextUploadEnabled: false,
        defaultAction: 'allow',
        paused: false,
        rules: [
          {
            action: 'block_capture',
            enabled: true,
            id: 'composition-sensitive-app',
            kind: 'bundle_id',
            pattern: 'com.example.sensitive',
            scope: 'workspace_default',
          },
        ],
      },
      ttlSeconds: 21_600,
      version: 'composition-policy-v1',
      workspaceId,
    },
    deliveryPolicy: { maxConcurrentOcr: 2 },
    deviceId,
    generatedAt,
    storagePolicy: {
      allowLongTermRemoteOriginal: false,
      authoritativeOriginalLocation: 'local_device',
      createdAt: generatedAt,
      id: '00000000-0000-4000-8000-000000000004',
      updatedAt: generatedAt,
      workspaceId,
    },
    workspaceId,
  };
}

type CaptureBundleSelection = {
  path: string;
  selection: 'configured' | 'default';
};

type LibwebpBuildProvenance = {
  architecture: string;
  deploymentTarget: string;
  libsharpyuvArchive: string;
  libwebpArchive: string;
  sourceSha256: string;
  version: string;
};

function resolveCaptureBundlePath(configuredPath: string | undefined): CaptureBundleSelection {
  const selection = configuredPath ? 'configured' : 'default';
  const requestedPath =
    configuredPath ?? path.join('macos', 'build', productIdentity.captureBundleDirectoryName);
  const resolvedPath = path.resolve(desktopRoot, requestedPath);

  if (!isPathInside(desktopRoot, resolvedPath) || path.extname(resolvedPath) !== '.app') {
    throw new Error('The configured capture bundle must be an application bundle inside desktop.');
  }

  return { path: resolvedPath, selection };
}

function validateCaptureBundleAvailability(selection: CaptureBundleSelection): boolean {
  const executablesExist = existsSync(launcherPath) && existsSync(captureBinaryPath);
  if (!executablesExist) {
    if (selection.selection === 'configured') {
      throw new Error('The configured capture bundle is unavailable.');
    }
    return false;
  }

  let canonicalBundlePath: string;
  try {
    canonicalBundlePath = realpathSync(selection.path);
  } catch {
    throw new Error('The configured capture bundle is unavailable.');
  }
  if (!isPathInside(realpathSync(desktopRoot), canonicalBundlePath)) {
    throw new Error('The configured capture bundle must be an application bundle inside desktop.');
  }

  return true;
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath !== '' && !relativePath.startsWith(`..${path.sep}`) && relativePath !== '..';
}

function readArchitectures(filePath: string): string[] {
  return execFileSync('/usr/bin/lipo', ['-archs', filePath], { encoding: 'utf8' })
    .trim()
    .split(/\s+/);
}

function readMinimumMacOSVersions(archivePath: string): string[] {
  const output = execFileSync('/usr/bin/otool', ['-l', archivePath], { encoding: 'utf8' });
  return [
    ...new Set(
      [...output.matchAll(/minos (\d+\.\d+(?:\.\d+)?)/g)].flatMap((match) =>
        match[1] ? [match[1]] : [],
      ),
    ),
  ];
}

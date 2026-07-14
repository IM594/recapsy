import { afterEach, describe, expect, it } from 'bun:test';
import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CaptureHelperEvent } from '../src/capture/public';
import { createHelperProcessClient } from '../src/helper/process-client';
import {
  HELPER_PROTOCOL_VERSION,
  type HelperEnvelope,
  type HelperToMainType,
} from '../src/helper/public';

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
const launcherPath = fileURLToPath(
  new URL('../macos/build/Recapsy.app/Contents/MacOS/CaptureLauncher', import.meta.url),
);
const captureBinaryPath = fileURLToPath(
  new URL('../macos/build/Recapsy.app/Contents/MacOS/Recapsy', import.meta.url),
);

const bundleBuilt = existsSync(launcherPath) && existsSync(captureBinaryPath);
// When the bundle has not been built yet (`pnpm run build:capture`), skip rather
// than fail: skipping is honest, a fabricated pass is not.
const bundleIt = bundleBuilt ? it : it.skip;

if (!bundleBuilt) {
  console.warn(
    'capture bundle not found — run `pnpm run build:capture` first; skipping bundle spawn tests.',
  );
}

const activeChildren: ChildProcess[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  for (const child of activeChildren.splice(0)) {
    if (isProcessAlive(child.pid)) {
      child.kill('SIGKILL');
    }
  }
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
  await delay(20);
});

describe('capture bundle subprocess (real signed Swift bundle via disclaim launcher)', () => {
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
    // Accessibility is out of 1B scope and must be reported as undetermined.
    expect(permission.payload.accessibility).toBe('not_determined');

    await client.stop();
  });

  bundleIt(
    'runs the capture loop after start and emits a protocol-valid capture envelope (or skips cleanly with no active window)',
    async () => {
      const { client, envelopes } = startBundleClient();
      await waitForEnvelope(envelopes, 'helper.hello');
      const heartbeatsBeforeStart = countEnvelopes(envelopes, 'helper.heartbeat');

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

  bundleIt('stop() exits the launcher and capture process with no zombie', async () => {
    const events: CaptureHelperEvent[] = [];
    const { client, envelopes, child } = startBundleClient(async (event) => {
      events.push(event);
    });
    await waitForEnvelope(envelopes, 'helper.hello');

    await client.stop();
    await waitForCondition(() => !isProcessAlive(child.pid), 4000);

    expect(isProcessAlive(child.pid)).toBe(false);
    expect(events).toHaveLength(0);
  });
});

function startBundleClient(onEvent?: (event: CaptureHelperEvent) => Promise<void>): {
  child: ChildProcess;
  client: ReturnType<typeof createHelperProcessClient>;
  envelopes: HelperEnvelope<HelperToMainType>[];
} {
  const assetRoot = mkdtempSync(path.join(tmpdir(), 'recapsy-capture-assets-'));
  tempRoots.push(assetRoot);

  let capturedChild: ChildProcess | undefined;
  const client = createHelperProcessClient({
    args: [captureBinaryPath],
    command: launcherPath,
    env: { RECAPSY_CAPTURE_ASSET_ROOT: assetRoot },
    shutdownTimeoutMs: 3000,
    spawnHelperProcess: (command, args, options) => {
      const child = nodeSpawn(command, args, { env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
      capturedChild = child;
      activeChildren.push(child);
      return child;
    },
  });

  const envelopes: HelperEnvelope<HelperToMainType>[] = [];
  const startPromise = client.start({
    onEnvelope: async (envelope) => {
      envelopes.push(envelope);
    },
    onEvent,
  });

  void startPromise.catch((error: unknown) => {
    console.error('capture bundle client failed to start', error);
  });

  if (!capturedChild) {
    throw new Error('capture bundle subprocess was not spawned synchronously');
  }

  return { child: capturedChild, client, envelopes };
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

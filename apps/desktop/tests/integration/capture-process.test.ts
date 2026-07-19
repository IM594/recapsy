import { afterEach, describe, expect, it } from 'bun:test';
import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  type CaptureHelperTransportEvent,
  type HelperEnvelope,
  type HelperToMainType,
  createHelperProcessClient,
} from '../../src/helper/index';

const devHelperPath = fileURLToPath(new URL('../../src/helper/dev-process.ts', import.meta.url));

const activeChildren: ChildProcess[] = [];

afterEach(async () => {
  for (const child of activeChildren.splice(0)) {
    if (isProcessAlive(child.pid)) {
      child.kill('SIGKILL');
    }
  }
  // Give the OS a tick to actually reap killed processes before the next test.
  await delay(20);
});

describe('capture helper subprocess (real cross-process transport)', () => {
  it('receives a real helper.hello and reaches a usable state', async () => {
    const { client, envelopes } = startRealHelperClient();

    const hello = await waitForEnvelope(envelopes, 'helper.hello');

    expect(hello.payload).toMatchObject({
      capabilities: { capture: true, mock: true },
    });

    await client.stop();
  });

  it('delivers a synthesized capture.result through the transport observer', async () => {
    const { client, envelopes, child } = startRealHelperClient();
    await waitForEnvelope(envelopes, 'helper.hello');

    child.kill('SIGUSR2');
    const captureResult = await waitForEnvelope(envelopes, 'capture.result');

    expect(captureResult.payload.captureId).toMatch(/^dev_capture_/);
    expect(captureResult.payload.assets).toHaveLength(1);
    expect(captureResult.payload.assets[0]?.role).toBe('screenshot');
    expect(captureResult.payload.context.app).toEqual({
      bundleId: 'one.recapsy.desktop.dev-helper',
      name: 'Recapsy Dev Helper',
    });
    expect(captureResult.payload.context.policy.decision).toBe('allow');

    await client.stop();
  });

  it('delivers pauseCapture/resumeCapture commands to the child over stdio', async () => {
    const { client, envelopes } = startRealHelperClient();
    await waitForEnvelope(envelopes, 'helper.hello');

    await client.pauseCapture();
    const paused = await waitForEnvelope(
      envelopes,
      'helper.status',
      (e) => e.payload.status === 'paused',
    );
    expect(paused.payload.status).toBe('paused');

    await client.resumeCapture();
    const resumed = await waitForEnvelope(
      envelopes,
      'helper.status',
      (e) => e.payload.status === 'ready' && envelopes.indexOf(e) > envelopes.indexOf(paused),
    );
    expect(resumed.payload.status).toBe('ready');

    await client.stop();
  });

  it('stop() causes the real child process to exit and leaves no zombie', async () => {
    const { client, envelopes, child, events } = startRealHelperClient();
    await waitForEnvelope(envelopes, 'helper.hello');

    await client.stop();
    await waitForCondition(() => !isProcessAlive(child.pid), 3000);

    expect(isProcessAlive(child.pid)).toBe(false);
    expect(events.filter((event) => event.type === 'process_exit')).toHaveLength(0);
  });

  it('reports process_exit when the helper process is force-killed (simulated crash)', async () => {
    const { envelopes, child, events } = startRealHelperClient();
    await waitForEnvelope(envelopes, 'helper.hello');

    child.kill('SIGKILL');

    await waitForCondition(() => events.length > 0, 3000);
    expect(events[0]).toMatchObject({ reason: 'process_crashed', type: 'process_exit' });
  });
});

function startRealHelperClient(): {
  child: ChildProcess;
  client: ReturnType<typeof createHelperProcessClient>;
  envelopes: HelperEnvelope<HelperToMainType>[];
  events: CaptureHelperTransportEvent[];
} {
  let capturedChild: ChildProcess | undefined;
  const client = createHelperProcessClient({
    args: [devHelperPath],
    command: 'bun',
    shutdownTimeoutMs: 3000,
    spawnHelperProcess: (command, args, options) => {
      const child = nodeSpawn(command, args, { env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
      capturedChild = child;
      activeChildren.push(child);
      return child;
    },
  });

  const envelopes: HelperEnvelope<HelperToMainType>[] = [];
  const events: CaptureHelperTransportEvent[] = [];

  // start() is async but resolves synchronously relative to the spawn call
  // in this implementation, so `capturedChild` is guaranteed to be set once
  // the promise below is created; we still await it before returning.
  const startPromise = client.start({
    async handle(event) {
      if (event.type === 'envelope') {
        envelopes.push(event.envelope);
      } else {
        events.push(event);
      }
    },
  });

  // `createHelperProcessClient().start()` spawns synchronously and has
  // no `await` before returning, so by the time this function returns,
  // `capturedChild` is already set even though we don't await the promise
  // here. Still surface any unexpected start() rejection instead of
  // swallowing it silently.
  void startPromise.catch((error: unknown) => {
    console.error('capture helper client failed to start', error);
  });

  if (!capturedChild) {
    throw new Error('capture helper subprocess was not spawned synchronously');
  }

  return { child: capturedChild, client, envelopes, events };
}

function waitForEnvelope<TType extends HelperToMainType>(
  envelopes: HelperEnvelope<HelperToMainType>[],
  type: TType,
  predicate: (envelope: HelperEnvelope<TType>) => boolean = () => true,
  timeoutMs = 3000,
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

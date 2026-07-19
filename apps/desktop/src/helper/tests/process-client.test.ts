import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { CaptureHelperTransportEvent, CaptureHelperTransportObserver } from '../index';
import { type HelperProcess, createHelperProcessClient } from '../process-client';
import { decodeHelperEnvelopeLine, encodeHelperEnvelope } from '../protocol/codec';
import type { HelperCapturePolicy, HelperEnvelope } from '../protocol/types';
import { validateMainToHelperEnvelope } from '../protocol/validation';

/**
 * Minimal fake standing in for a real `ChildProcess` so these tests can
 * exercise the client's framing, command-writing, and exit-classification
 * logic without spawning a real OS process. Real cross-process behavior is
 * covered separately by `tests/integration/capture-process.test.ts`, which
 * spawns the real dev helper script.
 */
class FakeChildProcess extends EventEmitter implements HelperProcess {
  readonly pid = 4321;
  readonly stdin: FakeWritable | null;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  lastKillSignal: NodeJS.Signals | number | undefined;

  constructor(stdin: FakeWritable | null = new FakeWritable()) {
    super();
    this.stdin = stdin;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.lastKillSignal = signal;
    return true;
  }
}

class FakeWritable {
  written: string[] = [];

  constructor(
    private readonly writeError?: Error,
    private readonly deferWriteResult = false,
  ) {}

  write(chunk: string, callback: (error?: Error | null) => void): boolean {
    this.written.push(chunk);
    if (this.deferWriteResult) {
      setTimeout(() => callback(this.writeError), 0);
    } else {
      callback(this.writeError);
    }
    return true;
  }
}

function writtenCommands(child: FakeChildProcess): string[] {
  if (!child.stdin) {
    throw new Error('Expected the fake child to have stdin.');
  }
  return child.stdin.written;
}

function helloLine(): string {
  const envelope: HelperEnvelope<'helper.hello'> = {
    correlationId: null,
    messageId: 'hello_1',
    payload: {
      capabilities: { capture: true, mock: true, permissions: false },
      helperVersion: 'fake/1.0.0',
      pid: 123,
    },
    protocolVersion: 'recapsy.capture-helper',
    sentAt: '2026-07-08T00:00:00.000Z',
    type: 'helper.hello',
  };
  return encodeHelperEnvelope(envelope);
}

function capturePolicy(): HelperCapturePolicy {
  return {
    defaultAction: 'allow',
    paused: false,
    policyHash: `sha256:${'a'.repeat(64)}`,
    rules: [],
    version: 'policy_1',
  };
}

function permissionStatusLine(
  correlationId: string | null,
  overrides: Partial<HelperEnvelope<'permission.status'>['payload']> = {},
): string {
  return encodeHelperEnvelope({
    correlationId,
    messageId: `permission_status_${correlationId ?? 'observation'}`,
    payload: {
      accessibility: 'granted',
      observedAt: '2026-07-19T00:00:00.000Z',
      screenCapture: 'granted',
      ...overrides,
    },
    protocolVersion: 'recapsy.capture-helper',
    sentAt: '2026-07-19T00:00:00.000Z',
    type: 'permission.status',
  });
}

async function completeStartup(
  client: ReturnType<typeof createHelperProcessClient>,
  child: FakeChildProcess,
  observer: CaptureHelperTransportObserver = discardTransportEvents,
): Promise<void> {
  const startPromise = client.start(observer);
  child.stdout.emit('data', helloLine());
  await startPromise;
}

const discardTransportEvents: CaptureHelperTransportObserver = {
  async handle() {},
};

function recordTransportEvents(
  events: CaptureHelperTransportEvent[],
): CaptureHelperTransportObserver {
  return {
    async handle(event) {
      events.push(event);
    },
  };
}

function recordTerminations(events: CaptureHelperTransportEvent[]): CaptureHelperTransportObserver {
  return {
    async handle(event) {
      if (event.type === 'process_exit') events.push(event);
    },
  };
}

function recordEnvelopes(received: HelperEnvelope[]): CaptureHelperTransportObserver {
  return {
    async handle(event) {
      if (event.type === 'envelope') received.push(event.envelope);
    },
  };
}

describe('helper process client', () => {
  it('does not resolve start until the first valid helper.hello arrives', async () => {
    const child = new FakeChildProcess();
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });
    let started = false;

    const startPromise = client.start(discardTransportEvents).then(() => {
      started = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(started).toBe(false);

    child.stdout.emit('data', helloLine());
    await startPromise;

    expect(started).toBe(true);
  });

  it('rejects a timed-out startup with a safe error and terminates the child', async () => {
    const child = new FakeChildProcess();
    const client = createHelperProcessClient({
      args: [],
      command: '/Users/alice/private/Recapsy',
      startupTimeoutMs: 10,
      spawnHelperProcess: () => child,
    });

    const result = await client.start(discardTransportEvents).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({
      code: 'handshake_timeout',
      message: 'Capture helper startup handshake timed out.',
      name: 'HelperProcessStartupError',
    });
    expect((result as Error).message).not.toContain('/Users/alice');
    expect(child.killed).toBe(true);
    expect(child.lastKillSignal).toBe('SIGKILL');
  });

  it('rejects a spawn error without leaking its raw path and terminates the child', async () => {
    const child = new FakeChildProcess();
    const events: CaptureHelperTransportEvent[] = [];
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    const startPromise = client
      .start(recordTransportEvents(events))
      .catch((error: unknown) => error);
    child.emit('error', new Error('spawn /Users/alice/private/Recapsy ENOENT'));
    const result = await startPromise;
    child.emit('exit', 1, null);

    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({
      code: 'spawn_failed',
      message: 'Capture helper failed to start.',
      name: 'HelperProcessStartupError',
    });
    expect((result as Error).message).not.toContain('/Users/alice');
    expect(child.killed).toBe(true);
    expect(events).toHaveLength(0);
  });

  it('normalizes a synchronous spawn failure into a safe structured error', async () => {
    const client = createHelperProcessClient({
      args: [],
      command: '/Users/alice/private/Recapsy',
      spawnHelperProcess: () => {
        throw new Error('spawn /Users/alice/private/Recapsy ENOENT');
      },
    });

    const result = await client.start(discardTransportEvents).catch((error: unknown) => error);

    expect(result).toMatchObject({
      code: 'spawn_failed',
      message: 'Capture helper failed to start.',
      name: 'HelperProcessStartupError',
    });
    expect(JSON.stringify(result)).not.toContain('/Users/alice');
  });

  it('rejects when the child exits before completing the startup handshake', async () => {
    const child = new FakeChildProcess();
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    const startPromise = client.start(discardTransportEvents).catch((error: unknown) => error);
    child.emit('exit', 1, null);
    const result = await startPromise;

    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({
      code: 'process_exit',
      message: 'Capture helper exited during startup.',
      name: 'HelperProcessStartupError',
    });
  });

  it('rejects and terminates startup when the first valid envelope is not helper.hello', async () => {
    const child = new FakeChildProcess();
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });
    const statusLine = encodeHelperEnvelope({
      correlationId: null,
      messageId: 'status_1',
      payload: { status: 'ready' },
      protocolVersion: 'recapsy.capture-helper',
      sentAt: '2026-07-08T00:00:00.000Z',
      type: 'helper.status',
    });

    const startPromise = client.start(discardTransportEvents).catch((error: unknown) => error);
    child.stdout.emit('data', statusLine);
    const result = await startPromise;

    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({
      code: 'protocol_invalid',
      message: 'Capture helper startup handshake failed.',
      name: 'HelperProcessStartupError',
    });
    expect(child.killed).toBe(true);
  });

  it('reports and immediately rejects malformed output during startup', async () => {
    const child = new FakeChildProcess();
    const protocolErrors: unknown[] = [];
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      onProtocolError: (error) => protocolErrors.push(error),
      spawnHelperProcess: () => child,
      startupTimeoutMs: 20,
    });

    const startPromise = client.start(discardTransportEvents).catch((error: unknown) => error);
    child.stdout.emit('data', 'not json at all\n');
    const result = await startPromise;

    expect(result).toMatchObject({
      code: 'protocol_invalid',
      message: 'Capture helper startup handshake failed.',
      name: 'HelperProcessStartupError',
    });
    expect(protocolErrors).toEqual([
      {
        code: 'invalid_json',
        message: 'Helper protocol line is not valid JSON.',
      },
    ]);
    expect(child.killed).toBe(true);
  });

  it('reports and rejects an invalid helper.hello without leaking envelope metadata', async () => {
    const child = new FakeChildProcess();
    const protocolErrors: unknown[] = [];
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      onProtocolError: (error) => protocolErrors.push(error),
      spawnHelperProcess: () => child,
    });
    const invalidHello = `${JSON.stringify({
      correlationId: '/Users/alice/private.txt',
      messageId: 'provider-secret-token',
      payload: { helperVersion: 'fake/1.0.0', pid: 123 },
      protocolVersion: 'recapsy.capture-helper',
      sentAt: '2026-07-08T00:00:00.000Z',
      type: 'helper.hello',
    })}\n`;

    const startPromise = client.start(discardTransportEvents).catch((error: unknown) => error);
    child.stdout.emit('data', invalidHello);
    const result = await startPromise;

    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({
      code: 'protocol_invalid',
      message: 'Capture helper startup handshake failed.',
      name: 'HelperProcessStartupError',
    });
    expect(protocolErrors).toEqual([
      {
        code: 'schema_mismatch',
        message: 'Helper envelope payload does not match its message type.',
        messageType: 'helper.hello',
      },
    ]);
    expect(JSON.stringify(protocolErrors)).not.toContain('/Users/alice');
    expect(JSON.stringify(protocolErrors)).not.toContain('provider-secret-token');
    expect(child.killed).toBe(true);
  });

  it('reports and rejects an unsupported helper.hello protocol version', async () => {
    const child = new FakeChildProcess();
    const protocolErrors: unknown[] = [];
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      onProtocolError: (error) => protocolErrors.push(error),
      spawnHelperProcess: () => child,
    });
    const incompatibleHello = `${JSON.stringify({
      correlationId: null,
      messageId: 'hello_1',
      payload: {
        capabilities: { capture: true, mock: false, permissions: true },
        helperVersion: 'fake/2.0.0',
        pid: 123,
      },
      protocolVersion: 'recapsy.capture-helper-v2',
      sentAt: '2026-07-08T00:00:00.000Z',
      type: 'helper.hello',
    })}\n`;

    const startPromise = client.start(discardTransportEvents).catch((error: unknown) => error);
    child.stdout.emit('data', incompatibleHello);
    const result = await startPromise;

    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({
      code: 'protocol_invalid',
      message: 'Capture helper startup handshake failed.',
      name: 'HelperProcessStartupError',
    });
    expect(protocolErrors).toHaveLength(1);
    expect(protocolErrors[0]).toMatchObject({
      code: 'unsupported_protocol_version',
      message: 'Helper protocol version is not supported.',
      messageType: 'helper.hello',
    });
    expect(child.killed).toBe(true);
  });

  it('spawns the helper in a dedicated process group on POSIX', async () => {
    const child = new FakeChildProcess();
    let detached: boolean | undefined;
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: (_command, _args, options) => {
        detached = options.detached;
        return child;
      },
    });

    await completeStartup(client, child);

    expect(detached).toBe(process.platform !== 'win32');
  });

  it('forwards well-formed envelopes through the transport observer', async () => {
    const child = new FakeChildProcess();
    const received: HelperEnvelope[] = [];
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await completeStartup(client, child, recordEnvelopes(received));

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('helper.hello');
  });

  it('splits multiple NDJSON lines arriving in one chunk', async () => {
    const child = new FakeChildProcess();
    const received: HelperEnvelope[] = [];
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    const startPromise = client.start(recordEnvelopes(received));
    child.stdout.emit('data', helloLine() + helloLine());
    await startPromise;

    expect(received).toHaveLength(2);
  });

  it('drops malformed lines without throwing and reports them via onProtocolError', async () => {
    const child = new FakeChildProcess();
    const protocolErrors: unknown[] = [];
    const received: HelperEnvelope[] = [];
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      onProtocolError: (error) => protocolErrors.push(error),
      spawnHelperProcess: () => child,
    });

    await completeStartup(client, child, recordEnvelopes(received));
    received.length = 0;
    expect(() => child.stdout.emit('data', 'not json at all\n')).not.toThrow();

    expect(received).toHaveLength(0);
    expect(protocolErrors).toHaveLength(1);
    expect(protocolErrors[0]).toMatchObject({ code: 'invalid_json' });
  });

  it('rejects Main-to-Helper commands received on helper stdout without leaking metadata', async () => {
    const child = new FakeChildProcess();
    const protocolErrors: unknown[] = [];
    const received: HelperEnvelope[] = [];
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      onProtocolError: (error) => protocolErrors.push(error),
      spawnHelperProcess: () => child,
    });

    await completeStartup(client, child, recordEnvelopes(received));
    received.length = 0;
    child.stdout.emit(
      'data',
      encodeHelperEnvelope({
        correlationId: '/Users/alice/private.txt',
        messageId: 'provider-secret-token',
        payload: { reason: 'runtime_started' },
        protocolVersion: 'recapsy.capture-helper',
        sentAt: '2026-07-08T00:00:00.000Z',
        type: 'capture.start',
      }),
    );

    expect(received).toHaveLength(0);
    expect(protocolErrors).toEqual([
      {
        code: 'schema_mismatch',
        message: 'Helper envelope type is not valid for this protocol direction.',
        messageType: 'capture.start',
      },
    ]);
    expect(JSON.stringify(protocolErrors)).not.toContain('/Users/alice');
    expect(JSON.stringify(protocolErrors)).not.toContain('provider-secret-token');
  });

  it('writes a valid capture.start envelope to stdin on beginCapture', async () => {
    const child = new FakeChildProcess();
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await completeStartup(client, child);
    await client.beginCapture('runtime_started');

    expect(writtenCommands(child)).toHaveLength(1);
    const decoded = decodeHelperEnvelopeLine(
      writtenCommands(child)[0] ?? '',
      validateMainToHelperEnvelope,
    );
    expect(decoded).toMatchObject({
      envelope: { type: 'capture.start', payload: { reason: 'runtime_started' } },
      ok: true,
    });
  });

  it('completes concurrent permission commands only with their matching correlation and still observes every status fact', async () => {
    const child = new FakeChildProcess();
    const received: HelperEnvelope[] = [];
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await completeStartup(client, child, recordEnvelopes(received));
    received.length = 0;

    const refresh = client.refreshPermissions({ timeoutMs: 100 });
    const request = client.requestScreenRecordingPermission({ timeoutMs: 100 });
    const refreshCommand = decodeHelperEnvelopeLine(
      writtenCommands(child)[0] ?? '',
      validateMainToHelperEnvelope,
    );
    const requestCommand = decodeHelperEnvelopeLine(
      writtenCommands(child)[1] ?? '',
      validateMainToHelperEnvelope,
    );

    expect(refreshCommand).toMatchObject({ envelope: { type: 'permission.refresh' }, ok: true });
    expect(requestCommand).toMatchObject({
      envelope: { type: 'permission.request_screen_capture' },
      ok: true,
    });
    if (!refreshCommand.ok || !requestCommand.ok) return;

    expect(refreshCommand.envelope.correlationId).toEqual(expect.any(String));
    expect(requestCommand.envelope.correlationId).toEqual(expect.any(String));
    expect(requestCommand.envelope.correlationId).not.toBe(refreshCommand.envelope.correlationId);

    child.stdout.emit(
      'data',
      permissionStatusLine(requestCommand.envelope.correlationId, {
        accessibility: 'denied',
        screenCapture: 'not_determined',
      }),
    );

    await expect(request).resolves.toEqual({
      accessibility: 'denied',
      screenRecording: 'not_determined',
    });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      correlationId: requestCommand.envelope.correlationId,
      type: 'permission.status',
    });

    child.stdout.emit('data', permissionStatusLine(refreshCommand.envelope.correlationId));

    await expect(refresh).resolves.toEqual({
      accessibility: 'granted',
      screenRecording: 'granted',
    });
    expect(received).toHaveLength(2);
  });

  it('does not complete a permission command from an unrelated status observation but still forwards it to the observer', async () => {
    const child = new FakeChildProcess();
    const received: HelperEnvelope[] = [];
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await completeStartup(client, child, recordEnvelopes(received));
    received.length = 0;
    const refresh = client.refreshPermissions({ timeoutMs: 25 });

    child.stdout.emit('data', permissionStatusLine('permission_other_request'));

    await expect(refresh).rejects.toMatchObject({
      code: 'permission_timeout',
      message: 'Capture helper permission command timed out.',
      name: 'HelperPermissionCommandError',
    });
    expect(received).toEqual([
      expect.objectContaining({
        correlationId: 'permission_other_request',
        type: 'permission.status',
      }),
    ]);
  });

  it('rejects every pending permission command when the helper process exits', async () => {
    const child = new FakeChildProcess();
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await completeStartup(client, child);
    const refresh = client.refreshPermissions({ timeoutMs: 100 });
    const request = client.requestScreenRecordingPermission({ timeoutMs: 100 });
    child.emit('exit', 1, null);

    const [refreshError, requestError] = await Promise.all([
      refresh.catch((error: unknown) => error),
      request.catch((error: unknown) => error),
    ]);

    expect(refreshError).toMatchObject({
      code: 'helper_unavailable',
      name: 'HelperTransportError',
    });
    expect(requestError).toMatchObject({
      code: 'helper_unavailable',
      name: 'HelperTransportError',
    });
  });

  it('rejects a pending permission command when stop begins', async () => {
    const child = new FakeChildProcess();
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await completeStartup(client, child);
    const refresh = client.refreshPermissions({ timeoutMs: 100 });
    const stop = client.stop();

    await expect(refresh).rejects.toMatchObject({
      code: 'helper_unavailable',
      name: 'HelperTransportError',
    });
    child.emit('exit', 0, null);
    await expect(stop).resolves.toBeUndefined();
  });

  it('contains permission command write failures behind the safe transport error', async () => {
    const child = new FakeChildProcess(
      new FakeWritable(new Error('write /Users/alice/private/permission.pipe EPIPE'), true),
    );
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await completeStartup(client, child);
    const result = await client
      .refreshPermissions({ timeoutMs: 100 })
      .catch((error: unknown) => error);

    expect(result).toMatchObject({
      code: 'helper_unavailable',
      message: 'Capture helper is unavailable.',
      name: 'HelperTransportError',
    });
    expect(JSON.stringify(result)).not.toContain('/Users/alice');
    expect(JSON.stringify(result)).not.toContain('EPIPE');
  });

  it('waits for a matching helper.policy_applied acknowledgement before policy configuration resolves', async () => {
    const child = new FakeChildProcess();
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await completeStartup(client, child);
    const configured = client.configureCapture(capturePolicy(), {
      deviceId: 'device_1',
      workspaceId: 'workspace_1',
    });
    const command = decodeHelperEnvelopeLine(
      writtenCommands(child)[0] ?? '',
      validateMainToHelperEnvelope,
    );
    expect(command).toMatchObject({
      envelope: {
        payload: {
          captureIdentity: { deviceId: 'device_1', workspaceId: 'workspace_1' },
        },
        type: 'helper.configure',
      },
      ok: true,
    });
    if (!command.ok) return;

    child.stdout.emit(
      'data',
      encodeHelperEnvelope({
        correlationId: command.envelope.correlationId,
        messageId: 'policy_applied_1',
        payload: { policyHash: capturePolicy().policyHash, policyVersion: 'policy_1' },
        protocolVersion: 'recapsy.capture-helper',
        sentAt: '2026-07-08T00:00:00.000Z',
        type: 'helper.policy_applied',
      }),
    );

    await expect(configured).resolves.toBeUndefined();
  });

  it('rejects a mismatched policy acknowledgement instead of starting with a different policy', async () => {
    const child = new FakeChildProcess();
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await completeStartup(client, child);
    const configured = client.configureCapture(capturePolicy());
    const command = decodeHelperEnvelopeLine(
      writtenCommands(child)[0] ?? '',
      validateMainToHelperEnvelope,
    );
    if (!command.ok) throw new Error('Expected helper.configure command.');

    child.stdout.emit(
      'data',
      encodeHelperEnvelope({
        correlationId: command.envelope.correlationId,
        messageId: 'policy_applied_wrong',
        payload: { policyHash: `sha256:${'b'.repeat(64)}`, policyVersion: 'policy_1' },
        protocolVersion: 'recapsy.capture-helper',
        sentAt: '2026-07-08T00:00:00.000Z',
        type: 'helper.policy_applied',
      }),
    );

    await expect(configured).rejects.toMatchObject({ code: 'policy_ack_mismatch' });
  });

  it('keeps policy configuration write failures behind the typed activation error', async () => {
    const child = new FakeChildProcess(
      new FakeWritable(new Error('write /Users/alice/private/policy.pipe EPIPE'), true),
    );
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await completeStartup(client, child);
    const result = await client.configureCapture(capturePolicy()).catch((error: unknown) => error);

    expect(result).toMatchObject({
      code: 'helper_unavailable',
      message: 'Capture helper is unavailable.',
      name: 'HelperPolicyActivationError',
    });
    expect(JSON.stringify(result)).not.toContain('/Users/alice');
    expect(JSON.stringify(result)).not.toContain('EPIPE');
  });

  it('rejects capture control commands with a safe typed error when no child is running', async () => {
    const child = new FakeChildProcess();
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await expect(client.beginCapture('runtime_started')).rejects.toMatchObject({
      code: 'helper_unavailable',
      message: 'Capture helper is unavailable.',
      name: 'HelperTransportError',
    });
    await expect(client.pauseCapture()).rejects.toMatchObject({
      code: 'helper_unavailable',
      name: 'HelperTransportError',
    });
    await expect(client.resumeCapture()).rejects.toMatchObject({
      code: 'helper_unavailable',
      name: 'HelperTransportError',
    });
    expect(writtenCommands(child)).toHaveLength(0);
  });

  it('rejects capture control commands with the same safe error when stdin is unavailable', async () => {
    const child = new FakeChildProcess(null);
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await completeStartup(client, child);

    await expect(client.beginCapture('runtime_started')).rejects.toMatchObject({
      code: 'helper_unavailable',
      message: 'Capture helper is unavailable.',
      name: 'HelperTransportError',
    });
    await expect(client.pauseCapture()).rejects.toMatchObject({
      code: 'helper_unavailable',
      name: 'HelperTransportError',
    });
    await expect(client.resumeCapture()).rejects.toMatchObject({
      code: 'helper_unavailable',
      name: 'HelperTransportError',
    });
  });

  it('writes an encoded capture.pause / capture.resume command to stdin', async () => {
    const child = new FakeChildProcess();
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await completeStartup(client, child);
    await client.pauseCapture();
    await client.resumeCapture();

    expect(writtenCommands(child)).toHaveLength(2);
    const pauseDecoded = decodeHelperEnvelopeLine(
      writtenCommands(child)[0] ?? '',
      validateMainToHelperEnvelope,
    );
    const resumeDecoded = decodeHelperEnvelopeLine(
      writtenCommands(child)[1] ?? '',
      validateMainToHelperEnvelope,
    );
    expect(pauseDecoded).toMatchObject({ envelope: { type: 'capture.pause' }, ok: true });
    expect(resumeDecoded).toMatchObject({ envelope: { type: 'capture.resume' }, ok: true });
  });

  it('writes a caller-built envelope to stdin verbatim via sendCommand', async () => {
    const child = new FakeChildProcess();
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await completeStartup(client, child);
    await client.sendCommand({
      correlationId: 'incoming_1',
      messageId: 'main_1',
      payload: { captureId: 'cap_1' },
      protocolVersion: 'recapsy.capture-helper',
      sentAt: '2026-07-08T00:00:00.000Z',
      type: 'capture.ack',
    });

    expect(writtenCommands(child)).toHaveLength(1);
    const decoded = decodeHelperEnvelopeLine(
      writtenCommands(child)[0] ?? '',
      validateMainToHelperEnvelope,
    );
    expect(decoded).toMatchObject({
      envelope: {
        correlationId: 'incoming_1',
        messageId: 'main_1',
        payload: { captureId: 'cap_1' },
        type: 'capture.ack',
      },
      ok: true,
    });
  });

  it('rejects sendCommand with the shared safe transport error when no child is running', async () => {
    const child = new FakeChildProcess();
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await expect(
      client.sendCommand({
        correlationId: null,
        messageId: 'main_1',
        payload: { captureId: 'cap_1' },
        protocolVersion: 'recapsy.capture-helper',
        sentAt: '2026-07-08T00:00:00.000Z',
        type: 'capture.ack',
      }),
    ).rejects.toMatchObject({
      code: 'helper_unavailable',
      message: 'Capture helper is unavailable.',
      name: 'HelperTransportError',
    });
    expect(writtenCommands(child)).toHaveLength(0);
  });

  it('contains stdin write failures behind the shared safe transport error', async () => {
    const child = new FakeChildProcess(
      new FakeWritable(new Error('write /Users/alice/private/capture.pipe EPIPE'), true),
    );
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await completeStartup(client, child);
    const result = await client
      .sendCommand({
        correlationId: null,
        messageId: 'main_1',
        payload: { captureId: 'cap_1' },
        protocolVersion: 'recapsy.capture-helper',
        sentAt: '2026-07-08T00:00:00.000Z',
        type: 'capture.ack',
      })
      .catch((error: unknown) => error);

    expect(result).toMatchObject({
      code: 'helper_unavailable',
      message: 'Capture helper is unavailable.',
      name: 'HelperTransportError',
    });
    expect(JSON.stringify(result)).not.toContain('/Users/alice');
    expect(JSON.stringify(result)).not.toContain('EPIPE');
  });

  it('reports process_exit when the child exits without stop() being called', async () => {
    const child = new FakeChildProcess();
    const events: CaptureHelperTransportEvent[] = [];
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await completeStartup(client, child, recordTerminations(events));
    child.emit('exit', 1, null);

    expect(events).toEqual([{ code: 1, reason: 'process_crashed', type: 'process_exit' }]);
  });

  it('classifies a signal-terminated exit as process_crashed', async () => {
    const child = new FakeChildProcess();
    const events: CaptureHelperTransportEvent[] = [];
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await completeStartup(client, child, recordTerminations(events));
    child.emit('exit', null, 'SIGKILL');

    expect(events).toEqual([{ code: null, reason: 'process_crashed', type: 'process_exit' }]);
  });

  it('does not report process_exit for an exit caused by stop()', async () => {
    const child = new FakeChildProcess();
    const events: CaptureHelperTransportEvent[] = [];
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await completeStartup(client, child, recordTerminations(events));

    const stopPromise = client.stop();
    child.emit('exit', 0, null);
    await stopPromise;

    expect(events).toHaveLength(0);
    const shutdownDecoded = decodeHelperEnvelopeLine(
      writtenCommands(child)[0] ?? '',
      validateMainToHelperEnvelope,
    );
    expect(shutdownDecoded).toMatchObject({ envelope: { type: 'helper.shutdown' }, ok: true });
  });

  it('force-kills the dedicated process group if shutdown times out', async () => {
    const child = new FakeChildProcess();
    const killedProcessGroups: Array<{ processGroupId: number; signal: NodeJS.Signals }> = [];
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      forceKillProcessGroup: (processGroupId, signal) => {
        killedProcessGroups.push({ processGroupId, signal });
        return true;
      },
      shutdownTimeoutMs: 20,
      spawnHelperProcess: () => child,
    });

    await completeStartup(client, child);
    const stopPromise = client.stop();
    // Never emit 'exit' — simulate a hung helper process.
    setTimeout(() => child.emit('exit', null, 'SIGKILL'), 40);
    await stopPromise;

    expect(killedProcessGroups).toEqual([{ processGroupId: 4321, signal: 'SIGKILL' }]);
    expect(child.killed).toBe(false);
  });

  it('rejects with a safe typed error when the child stays alive after force-kill grace', async () => {
    const child = new FakeChildProcess();
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      forceKillProcessGroup: () => true,
      shutdownTimeoutMs: 5,
      spawnHelperProcess: () => child,
    });

    await completeStartup(client, child);

    await expect(client.stop()).rejects.toMatchObject({
      code: 'helper_shutdown_failed',
      message: 'Capture helper failed to shut down.',
      name: 'HelperTransportError',
    });
  });

  it('keeps stop idempotent when no child is running', async () => {
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => new FakeChildProcess(),
    });

    await expect(client.stop()).resolves.toBeUndefined();
  });

  it('reports process_exit with no leaked message when the process errors after startup', async () => {
    const child = new FakeChildProcess();
    const events: CaptureHelperTransportEvent[] = [];
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await completeStartup(client, child, recordTerminations(events));
    child.emit('error', new Error('spawn /Users/alice/secret/helper ENOENT'));

    expect(events).toEqual([{ code: null, reason: 'unknown', type: 'process_exit' }]);
    expect(JSON.stringify(events)).not.toContain('/Users/alice');
  });
});

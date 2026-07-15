import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { CaptureHelperEvent } from '../../capture/index';
import { type HelperProcess, createHelperProcessClient } from '../process-client';
import { decodeHelperEnvelopeLine, encodeHelperEnvelope } from '../protocol/codec';
import type { HelperEnvelope } from '../protocol/types';
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
  readonly stdin = new FakeWritable();
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  lastKillSignal: NodeJS.Signals | number | undefined;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.lastKillSignal = signal;
    return true;
  }
}

class FakeWritable {
  written: string[] = [];

  write(chunk: string): boolean {
    this.written.push(chunk);
    return true;
  }
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

describe('helper process client', () => {
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

    await client.start();

    expect(detached).toBe(process.platform !== 'win32');
  });

  it('forwards well-formed envelopes from stdout to onEnvelope', async () => {
    const child = new FakeChildProcess();
    const received: HelperEnvelope[] = [];
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await client.start({ onEnvelope: async (envelope) => void received.push(envelope) });
    child.stdout.emit('data', Buffer.from(helloLine()));

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

    await client.start({ onEnvelope: async (envelope) => void received.push(envelope) });
    child.stdout.emit('data', helloLine() + helloLine());

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

    await client.start({ onEnvelope: async (envelope) => void received.push(envelope) });
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

    await client.start({ onEnvelope: async (envelope) => void received.push(envelope) });
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

    await client.start();
    await client.beginCapture('runtime_started');

    expect(child.stdin.written).toHaveLength(1);
    const decoded = decodeHelperEnvelopeLine(
      child.stdin.written[0] ?? '',
      validateMainToHelperEnvelope,
    );
    expect(decoded).toMatchObject({
      envelope: { type: 'capture.start', payload: { reason: 'runtime_started' } },
      ok: true,
    });
  });

  it('drops beginCapture writes silently when no child is running', async () => {
    const child = new FakeChildProcess();
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await expect(client.beginCapture('runtime_started')).resolves.toBeUndefined();
    expect(child.stdin.written).toHaveLength(0);
  });

  it('writes an encoded capture.pause / capture.resume command to stdin', async () => {
    const child = new FakeChildProcess();
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await client.start();
    await client.pauseCapture();
    await client.resumeCapture();

    expect(child.stdin.written).toHaveLength(2);
    const pauseDecoded = decodeHelperEnvelopeLine(
      child.stdin.written[0] ?? '',
      validateMainToHelperEnvelope,
    );
    const resumeDecoded = decodeHelperEnvelopeLine(
      child.stdin.written[1] ?? '',
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

    await client.start();
    await client.sendCommand({
      correlationId: 'incoming_1',
      messageId: 'main_1',
      payload: { captureId: 'cap_1' },
      protocolVersion: 'recapsy.capture-helper',
      sentAt: '2026-07-08T00:00:00.000Z',
      type: 'capture.ack',
    });

    expect(child.stdin.written).toHaveLength(1);
    const decoded = decodeHelperEnvelopeLine(
      child.stdin.written[0] ?? '',
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

  it('drops sendCommand writes silently when no child is running', async () => {
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
    ).resolves.toBeUndefined();
    expect(child.stdin.written).toHaveLength(0);
  });

  it('reports unexpectedExit when the child exits without stop() being called', async () => {
    const child = new FakeChildProcess();
    const events: CaptureHelperEvent[] = [];
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await client.start({ onEvent: async (event) => void events.push(event) });
    child.emit('exit', 1, null);

    expect(events).toEqual([{ code: 1, reason: 'process_crashed', type: 'unexpectedExit' }]);
  });

  it('classifies a signal-terminated exit as process_crashed', async () => {
    const child = new FakeChildProcess();
    const events: CaptureHelperEvent[] = [];
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await client.start({ onEvent: async (event) => void events.push(event) });
    child.emit('exit', null, 'SIGKILL');

    expect(events).toEqual([{ code: null, reason: 'process_crashed', type: 'unexpectedExit' }]);
  });

  it('does not report unexpectedExit for an exit caused by stop()', async () => {
    const child = new FakeChildProcess();
    const events: CaptureHelperEvent[] = [];
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await client.start({ onEvent: async (event) => void events.push(event) });

    const stopPromise = client.stop();
    child.emit('exit', 0, null);
    await stopPromise;

    expect(events).toHaveLength(0);
    const shutdownDecoded = decodeHelperEnvelopeLine(
      child.stdin.written[0] ?? '',
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

    await client.start();
    const stopPromise = client.stop();
    // Never emit 'exit' — simulate a hung helper process.
    setTimeout(() => child.emit('exit', null, 'SIGKILL'), 40);
    await stopPromise;

    expect(killedProcessGroups).toEqual([{ processGroupId: 4321, signal: 'SIGKILL' }]);
    expect(child.killed).toBe(false);
  });

  it('reports unexpectedExit with no leaked message when spawning fails', async () => {
    const child = new FakeChildProcess();
    const events: CaptureHelperEvent[] = [];
    const client = createHelperProcessClient({
      args: [],
      command: 'fake',
      spawnHelperProcess: () => child,
    });

    await client.start({ onEvent: async (event) => void events.push(event) });
    child.emit('error', new Error('spawn /Users/alice/secret/helper ENOENT'));

    expect(events).toEqual([{ code: null, reason: 'unknown', type: 'unexpectedExit' }]);
    expect(JSON.stringify(events)).not.toContain('/Users/alice');
  });
});

import { describe, expect, it } from 'bun:test';
import { createDevHelperRuntime } from './dev-process';
import { decodeHelperEnvelopeLine, encodeHelperEnvelope } from './protocol/codec';
import {
  HELPER_PROTOCOL_VERSION,
  type HelperEnvelope,
  type MainToHelperPayloadByType,
  type MainToHelperType,
} from './protocol/types';
import { validateHelperToMainEnvelope, validateMainToHelperEnvelope } from './protocol/validation';

const now = '2026-07-08T00:00:00.000Z';

function commandEnvelope<TType extends MainToHelperType>(
  type: TType,
  payload: MainToHelperPayloadByType[TType],
): HelperEnvelope<TType> {
  return {
    correlationId: null,
    messageId: `cmd_${type}`,
    payload,
    protocolVersion: HELPER_PROTOCOL_VERSION,
    sentAt: now,
    type,
  } as HelperEnvelope<TType>;
}

describe('dev helper runtime', () => {
  it('emits a helper.hello with mock capabilities on start', () => {
    const lines: string[] = [];
    const runtime = createDevHelperRuntime({ emit: (line) => lines.push(line), now: () => now });

    runtime.start();

    expect(lines).toHaveLength(1);
    const decoded = decodeHelperEnvelopeLine(lines[0] ?? '', validateHelperToMainEnvelope);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.envelope.type).toBe('helper.hello');
    expect(decoded.envelope.payload).toMatchObject({
      capabilities: { capture: true, mock: true, permissions: false },
    });
  });

  it('moves to ready on capture.start and reports helper.status', () => {
    const lines: string[] = [];
    const runtime = createDevHelperRuntime({ emit: (line) => lines.push(line), now: () => now });

    runtime.handleEnvelope({
      envelope: commandEnvelope('capture.start', { reason: 'runtime_started' }),
      ok: true,
    });

    expect(runtime.getState()).toBe('ready');
    const decoded = decodeHelperEnvelopeLine(lines[0] ?? '', validateHelperToMainEnvelope);
    expect(decoded).toMatchObject({
      envelope: { payload: { status: 'ready' }, type: 'helper.status' },
      ok: true,
    });
  });

  it('pauses and resumes, emitting helper.status for each transition', () => {
    const lines: string[] = [];
    const runtime = createDevHelperRuntime({ emit: (line) => lines.push(line), now: () => now });

    runtime.handleEnvelope({
      envelope: commandEnvelope('capture.pause', { reason: 'user_paused' }),
      ok: true,
    });
    expect(runtime.getState()).toBe('paused');

    runtime.handleEnvelope({
      envelope: commandEnvelope('capture.resume', { reason: 'user_resumed' }),
      ok: true,
    });
    expect(runtime.getState()).toBe('ready');

    const decodedPause = decodeHelperEnvelopeLine(lines[0] ?? '', validateHelperToMainEnvelope);
    const decodedResume = decodeHelperEnvelopeLine(lines[1] ?? '', validateHelperToMainEnvelope);
    expect(decodedPause).toMatchObject({ envelope: { payload: { status: 'paused' } }, ok: true });
    expect(decodedResume).toMatchObject({ envelope: { payload: { status: 'ready' } }, ok: true });
  });

  it('ignores malformed or protocol-invalid input instead of throwing', () => {
    const lines: string[] = [];
    const runtime = createDevHelperRuntime({ emit: (line) => lines.push(line), now: () => now });

    expect(() =>
      runtime.handleEnvelope({
        error: { code: 'invalid_json', message: 'not json' },
        ok: false,
      }),
    ).not.toThrow();
    expect(lines).toHaveLength(0);
    expect(runtime.getState()).toBe('starting');
  });

  it('rejects Helper-to-Main events received on helper stdin without changing state', () => {
    const lines: string[] = [];
    const runtime = createDevHelperRuntime({ emit: (line) => lines.push(line), now: () => now });
    const result = decodeHelperEnvelopeLine(
      encodeHelperEnvelope({
        correlationId: '/Users/alice/private.txt',
        messageId: 'provider-secret-token',
        payload: { sequence: 1, status: 'ready' },
        protocolVersion: HELPER_PROTOCOL_VERSION,
        sentAt: now,
        type: 'helper.heartbeat',
      }),
      validateMainToHelperEnvelope,
    );

    expect(result).toMatchObject({ error: { code: 'schema_mismatch' }, ok: false });
    expect(JSON.stringify(result)).not.toContain('/Users/alice');
    expect(JSON.stringify(result)).not.toContain('provider-secret-token');
    runtime.handleEnvelope(result);
    expect(runtime.getState()).toBe('starting');
    expect(lines).toEqual([]);
  });

  it('synthesizes a well-formed capture.result reflecting the configured policy version', () => {
    const lines: string[] = [];
    const runtime = createDevHelperRuntime({ emit: (line) => lines.push(line), now: () => now });

    runtime.handleEnvelope({
      envelope: commandEnvelope('helper.configure', { policyVersion: 'policy_v7' }),
      ok: true,
    });

    const envelope = runtime.synthesizeCapture();

    expect(envelope.type).toBe('capture.result');
    expect(envelope.payload.context.policy.version).toBe('policy_v7');
    const roundTripped = decodeHelperEnvelopeLine(
      encodeHelperEnvelope(envelope),
      validateHelperToMainEnvelope,
    );
    expect(roundTripped.ok).toBe(true);
  });

  it('marks itself shutdown and emits helper.exiting on helper.shutdown', () => {
    const lines: string[] = [];
    const runtime = createDevHelperRuntime({ emit: (line) => lines.push(line), now: () => now });

    expect(runtime.isShutdown()).toBe(false);

    runtime.handleEnvelope({
      envelope: commandEnvelope('helper.shutdown', { reason: 'quit' }),
      ok: true,
    });

    expect(runtime.isShutdown()).toBe(true);
    const decoded = decodeHelperEnvelopeLine(lines[0] ?? '', validateHelperToMainEnvelope);
    expect(decoded).toMatchObject({
      envelope: { payload: { reason: 'shutdown_requested' }, type: 'helper.exiting' },
      ok: true,
    });
  });
});

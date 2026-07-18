import { describe, expect, it } from 'bun:test';
import { HELPER_PROTOCOL_VERSION, type HelperEnvelope } from '../../helper/index';
import { createDevVisibility } from '../dev-visibility';

function captureResultEnvelope(): HelperEnvelope<'capture.result'> {
  return {
    correlationId: null,
    messageId: 'message_1',
    payload: {
      assets: [
        {
          hash: 'hash_1',
          mimeType: 'image/png',
          ref: 'opaque:asset:capture_1',
          role: 'screenshot',
          sizeBytes: 42,
        },
      ],
      captureId: 'capture_1',
      context: {
        app: { bundleId: 'com.apple.Safari', name: 'Safari' },
        observedAt: '2026-07-15T00:00:00.000Z',
        policy: { decision: 'allow', version: 'policy_1' },
      },
      manifest: {
        hash: 'hash_1',
        mimeType: 'application/json',
        ref: 'opaque:manifest:capture_1',
        role: 'manifest',
        sizeBytes: 0,
      },
      observedAt: '2026-07-15T00:00:00.000Z',
    },
    protocolVersion: HELPER_PROTOCOL_VERSION,
    sentAt: '2026-07-15T00:00:00.000Z',
    type: 'capture.result',
  };
}

describe('desktop development visibility', () => {
  it('projects capture and sync activity without logging raw payload data', () => {
    const lines: unknown[][] = [];
    const visibility = createDevVisibility({
      logger: {
        error: (...args) => lines.push(args),
        log: (...args) => lines.push(args),
      },
    });

    visibility.onHelperEnvelope(captureResultEnvelope());
    visibility.onSyncResult({ jobId: 'job_1', processed: 1, status: 'synced' });
    visibility.onSyncError(new Error('secret-token /Users/private/capture.png'));

    const output = JSON.stringify(lines);
    expect(output).toContain('captureId=capture_1');
    expect(output).toContain('status=synced');
    expect(output).not.toContain('secret-token');
    expect(output).not.toContain('/Users/private');
    expect(output).not.toContain('opaque:asset');
  });

  it('keeps helper heartbeats and idle sync results silent', () => {
    const lines: unknown[][] = [];
    const visibility = createDevVisibility({
      logger: {
        error: (...args) => lines.push(args),
        log: (...args) => lines.push(args),
      },
    });
    const heartbeat = {
      ...captureResultEnvelope(),
      payload: { sequence: 1 },
      type: 'helper.heartbeat',
    } as HelperEnvelope<'helper.heartbeat'>;

    visibility.onHelperEnvelope(heartbeat);
    visibility.onSyncResult({ processed: 0, status: 'idle' });

    expect(lines).toEqual([]);
  });

  it('redacts sensitive values even when they occupy diagnostic identifier fields', () => {
    const lines: unknown[][] = [];
    const visibility = createDevVisibility({
      logger: {
        error: (...args) => lines.push(args),
        log: (...args) => lines.push(args),
      },
    });
    const envelope = captureResultEnvelope();
    envelope.payload.captureId = 'auth-token-secret /Users/private/capture.png';

    visibility.onHelperEnvelope(envelope);
    visibility.onSyncResult({
      jobId: 'secret-token-job',
      processed: 1,
      status: 'retry_wait',
    });

    const output = JSON.stringify(lines);
    expect(output).not.toContain('auth-token-secret');
    expect(output).not.toContain('/Users/private');
    expect(output).not.toContain('secret-token-job');
  });
});

import { describe, expect, it } from 'bun:test';
import type { CaptureResultPayload } from '../../helper/index';
import { projectCaptureOutboxEntry } from '../outbox-entry';

const observedAt = '2026-07-07T08:00:00.000Z';
const workspaceId = 'workspace_1';
const deviceId = 'device_1';

describe('capture outbox entry projection', () => {
  it('preserves the exact entry shape and canonical payload hash for redacted context', () => {
    const result = projectCaptureOutboxEntry({
      deviceId,
      payload: capturePayload({
        context: {
          app: { bundleId: 'com.apple.Safari', name: 'Safari' },
          document: { name: 'plan.md' },
          observedAt,
          policy: { decision: 'redact_context', version: 'policy_1' },
          website: { host: 'example.test', origin: 'https://example.test' },
          window: { title: 'Planning' },
        },
      }),
      workspaceId,
    });

    expect(result).toEqual({
      assetRefs: [
        {
          assetRefId: 'asset_capture_1',
          availabilityState: 'available',
          cleanupState: 'retained',
          contentAddress: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          createdAt: observedAt,
          hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          localAccessKey: 'asset_capture_1',
          mimeType: 'image/png',
          role: 'capture_original',
          sizeBytes: 4096,
          workspaceId,
        },
      ],
      assetRefId: 'asset_capture_1',
      capture: {
        appName: 'Safari',
        bundleId: 'com.apple.Safari',
        capturedAt: observedAt,
        captureType: 'screen',
        documentPathCandidate: { kind: 'redacted', reason: 'policy_redacted' },
        localEventId: 'capture_1',
        observedAt,
        privacyDecision: {
          action: 'redact_context',
          decidedAt: observedAt,
          policyVersion: 'policy_1',
          reasons: ['redact_context'],
        },
        urlCandidate: { kind: 'redacted', reason: 'policy_redacted' },
        windowTitleCandidate: { kind: 'redacted', reason: 'policy_redacted' },
      },
      createdAt: observedAt,
      deviceId,
      id: 'capture_1',
      idempotencyKey: 'workspace_1:capture_1',
      payloadHash: 'sha256:6ab438bc1f513a40719bbaadae11773354ac65e17938d906a9766dee7618a32f',
      workspaceId,
    });
    expect(Object.keys(result ?? {})).toEqual([
      'assetRefs',
      'assetRefId',
      'capture',
      'createdAt',
      'deviceId',
      'id',
      'idempotencyKey',
      'payloadHash',
      'workspaceId',
    ]);
    expect(canonicalHashJson(result)).toBe(
      '{"assetRefId":"asset_capture_1","assetRefs":[{"assetRefId":"asset_capture_1","availabilityState":"available","cleanupState":"retained","contentAddress":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","createdAt":"2026-07-07T08:00:00.000Z","hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","localAccessKey":"asset_capture_1","mimeType":"image/png","role":"capture_original","sizeBytes":4096,"workspaceId":"workspace_1"}],"capture":{"appName":"Safari","bundleId":"com.apple.Safari","capturedAt":"2026-07-07T08:00:00.000Z","captureType":"screen","documentPathCandidate":{"kind":"redacted","reason":"policy_redacted"},"localEventId":"capture_1","observedAt":"2026-07-07T08:00:00.000Z","privacyDecision":{"action":"redact_context","decidedAt":"2026-07-07T08:00:00.000Z","policyVersion":"policy_1","reasons":["redact_context"]},"urlCandidate":{"kind":"redacted","reason":"policy_redacted"},"windowTitleCandidate":{"kind":"redacted","reason":"policy_redacted"}},"workspaceId":"workspace_1"}',
    );
  });

  it('prefers capturedAt over observedAt when the helper reports both', () => {
    const capturedAt = '2026-07-07T08:00:00.500Z';
    const payload = capturePayload({ capturedAt });

    const result = projectCaptureOutboxEntry({ deviceId, payload, workspaceId });

    expect(result.capture?.capturedAt).toBe(capturedAt);
    expect(result.createdAt).toBe(observedAt);
  });

  it('persists the opaque context fingerprint without persisting raw context paths', () => {
    const contextFingerprint = `sha256:${'c'.repeat(64)}`;
    const result = projectCaptureOutboxEntry({
      deviceId,
      payload: capturePayload({
        context: {
          app: { bundleId: 'com.apple.Safari', name: 'Safari' },
          contextFingerprint,
          document: { name: 'plan.md' },
          observedAt,
          policy: { decision: 'allow', version: 'policy_1' },
        },
      }),
      workspaceId,
    });

    expect(result.capture).toMatchObject({ contextFingerprint });
    expect(JSON.stringify(result.capture)).not.toContain('/Users/');
  });

  it('falls back to observedAt for capturedAt when the helper does not report it', () => {
    const payload = capturePayload();

    const result = projectCaptureOutboxEntry({ deviceId, payload, workspaceId });

    expect(result.capture?.capturedAt).toBe(observedAt);
  });

  it('keeps unsafe refs out of localAccessKey without changing their identity fields', () => {
    const payload = capturePayload({
      assets: [{ ...screenshotAsset(), ref: '/Users/alice/private.png' }],
    });

    const result = projectCaptureOutboxEntry({ deviceId, payload, workspaceId });

    expect(result).toMatchObject({
      assetRefId: '/Users/alice/private.png',
      assetRefs: [
        {
          assetRefId: '/Users/alice/private.png',
          localAccessKey: 'opaque:asset:capture_1',
        },
      ],
    });
  });
});

function capturePayload(overrides: Partial<CaptureResultPayload> = {}): CaptureResultPayload {
  return {
    assets: [screenshotAsset()],
    captureId: 'capture_1',
    context: {
      app: { bundleId: 'com.apple.Safari', name: 'Safari' },
      observedAt,
      policy: { decision: 'allow', version: 'policy_1' },
    },
    observedAt,
    ...overrides,
  };
}

function screenshotAsset() {
  return {
    hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    mimeType: 'image/png',
    ref: 'asset_capture_1',
    role: 'screenshot' as const,
    sizeBytes: 4096,
  };
}

function canonicalHashJson(entry: ReturnType<typeof projectCaptureOutboxEntry>): string {
  return JSON.stringify({
    assetRefId: entry.assetRefId,
    assetRefs: entry.assetRefs,
    capture: entry.capture,
    workspaceId: entry.workspaceId,
  });
}

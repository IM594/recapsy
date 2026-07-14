import { describe, expect, it } from 'bun:test';
import type { CaptureResultPayload } from '../helper/public';
import { projectCaptureOutboxEntry } from './outbox-entry';

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
        {
          assetRefId: 'asset_capture_1_thumb',
          availabilityState: 'available',
          cleanupState: 'retained',
          contentAddress: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          createdAt: observedAt,
          hash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          localAccessKey: 'asset_capture_1_thumb',
          mimeType: 'image/png',
          role: 'capture_thumbnail',
          sizeBytes: 512,
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
      payloadHash: 'sha256:aa5c2aba6044a567020fa50505ea370b077df6fc5761b8b01c06e00244b09623',
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
      '{"assetRefId":"asset_capture_1","assetRefs":[{"assetRefId":"asset_capture_1","availabilityState":"available","cleanupState":"retained","contentAddress":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","createdAt":"2026-07-07T08:00:00.000Z","hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","localAccessKey":"asset_capture_1","mimeType":"image/png","role":"capture_original","sizeBytes":4096,"workspaceId":"workspace_1"},{"assetRefId":"asset_capture_1_thumb","availabilityState":"available","cleanupState":"retained","contentAddress":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","createdAt":"2026-07-07T08:00:00.000Z","hash":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","localAccessKey":"asset_capture_1_thumb","mimeType":"image/png","role":"capture_thumbnail","sizeBytes":512,"workspaceId":"workspace_1"}],"capture":{"appName":"Safari","bundleId":"com.apple.Safari","capturedAt":"2026-07-07T08:00:00.000Z","captureType":"screen","documentPathCandidate":{"kind":"redacted","reason":"policy_redacted"},"localEventId":"capture_1","observedAt":"2026-07-07T08:00:00.000Z","privacyDecision":{"action":"redact_context","decidedAt":"2026-07-07T08:00:00.000Z","policyVersion":"policy_1","reasons":["redact_context"]},"urlCandidate":{"kind":"redacted","reason":"policy_redacted"},"windowTitleCandidate":{"kind":"redacted","reason":"policy_redacted"}},"workspaceId":"workspace_1"}',
    );
  });

  it('selects the screenshot while preserving filtered assetRefs input order in the hash', () => {
    const payload = capturePayload({
      assets: [thumbnailAsset(), manifestAsset(), screenshotAsset()],
      context: {
        app: { bundleId: 'com.apple.Safari', name: 'Safari' },
        observedAt,
        policy: { decision: 'allow', version: 'policy_1' },
        website: { host: 'example.test', origin: 'https://example.test' },
        window: { title: 'Planning' },
      },
    });

    const result = projectCaptureOutboxEntry({ deviceId, payload, workspaceId });

    expect(result?.assetRefId).toBe('asset_capture_1');
    expect(result?.assetRefs.map((assetRef) => assetRef.assetRefId)).toEqual([
      'asset_capture_1_thumb',
      'asset_capture_1',
    ]);
    expect(result?.payloadHash).toBe(
      'sha256:e39c3cfe271f3895e7045b025c1dd598b468758abf89eb2317f659d6c8f970a6',
    );
  });

  it('uses a thumbnail as primary when no screenshot exists and returns null for manifest-only input', () => {
    const thumbnailOnly = capturePayload({ assets: [manifestAsset(), thumbnailAsset()] });
    const manifestOnly = capturePayload({ assets: [manifestAsset()] });

    expect(
      projectCaptureOutboxEntry({ deviceId, payload: thumbnailOnly, workspaceId }),
    ).toMatchObject({
      assetRefId: 'asset_capture_1_thumb',
      assetRefs: [{ assetRefId: 'asset_capture_1_thumb', role: 'capture_thumbnail' }],
    });
    expect(projectCaptureOutboxEntry({ deviceId, payload: manifestOnly, workspaceId })).toBeNull();
  });

  it('keeps unsafe refs out of localAccessKey without changing their identity fields', () => {
    const payload = capturePayload({
      assets: [
        { ...screenshotAsset(), ref: '/Users/alice/private.png' },
        { ...thumbnailAsset(), ref: 'provider-token-private-value' },
      ],
    });

    const result = projectCaptureOutboxEntry({ deviceId, payload, workspaceId });

    expect(result).toMatchObject({
      assetRefId: '/Users/alice/private.png',
      assetRefs: [
        {
          assetRefId: '/Users/alice/private.png',
          localAccessKey: 'opaque:asset:capture_1',
        },
        {
          assetRefId: 'provider-token-private-value',
          localAccessKey: '[redacted:content]',
        },
      ],
    });
  });
});

function capturePayload(overrides: Partial<CaptureResultPayload> = {}): CaptureResultPayload {
  return {
    assets: [screenshotAsset(), thumbnailAsset(), manifestAsset()],
    captureId: 'capture_1',
    context: {
      observedAt,
      policy: { decision: 'allow', version: 'policy_1' },
    },
    manifest: manifestAsset(),
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

function thumbnailAsset() {
  return {
    hash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    mimeType: 'image/png',
    ref: 'asset_capture_1_thumb',
    role: 'thumbnail' as const,
    sizeBytes: 512,
  };
}

function manifestAsset() {
  return {
    hash: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    mimeType: 'application/json',
    ref: 'manifest_in_assets',
    role: 'manifest' as const,
    sizeBytes: 64,
  };
}

function canonicalHashJson(
  entry: ReturnType<typeof projectCaptureOutboxEntry>,
): string | undefined {
  if (!entry) return undefined;
  return JSON.stringify({
    assetRefId: entry.assetRefId,
    assetRefs: entry.assetRefs,
    capture: entry.capture,
    workspaceId: entry.workspaceId,
  });
}

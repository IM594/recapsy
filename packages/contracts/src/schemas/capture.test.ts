import { describe, expect, it } from 'bun:test';
import { CaptureCreateRequestSchema } from '../index.js';

const now = '2026-07-06T00:00:00.000Z';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const captureCreateRequest = {
  workspaceId,
  deviceId: 'macbook-pro-01',
  localEventId: 'local-event-01',
  capturedAt: now,
  observedAt: now,
  appName: 'Safari',
  bundleId: 'com.apple.Safari',
  windowTitleCandidate: { kind: 'safe', value: 'Recapsy design notes' },
  urlCandidate: {
    kind: 'safe',
    normalized: 'https://example.test/docs',
    domain: 'example.test',
  },
  documentPathCandidate: { kind: 'omitted', reason: 'not_available' },
  contextFingerprint: 'sha256:context-fingerprint',
  contextConfidence: 'high',
  captureType: 'screen',
  privacyDecision: {
    action: 'allow',
    decidedAt: now,
    policyVersion: 'capture-policy-v1',
    reasons: ['default_allow'],
  },
  idempotencyKey: 'capture-create-key-01',
  localAssets: [
    {
      role: 'screenshot_original',
      localDeviceAssetRef: 'local-asset-original-01',
      mimeType: 'image/png',
      width: 1440,
      height: 900,
      byteSize: 512000,
      contentHash: 'sha256:original-hash',
      availability: 'available',
      stagingManifestId: 'manifest-01',
    },
    {
      role: 'ocr_input_image',
      localDeviceAssetRef: 'local-asset-ocr-01',
      mimeType: 'image/jpeg',
      width: 1024,
      height: 640,
      byteSize: 128000,
      contentHash: 'sha256:ocr-input-hash',
      availability: 'available',
    },
  ],
  contentHash: 'sha256:original-hash',
  perceptualHash: 'phash:abcd1234',
  blankScore: 0.01,
  duplicateHint: { status: 'unique' },
  secureOrPrivateHint: { detected: false },
  metadata: { helperVersion: '0.1.0' },
} as const;

describe('capture creation contracts', () => {
  it('parses valid capture creation requests using workspaceId, not tenantId', () => {
    const parsed = CaptureCreateRequestSchema.parse(captureCreateRequest);
    expect(parsed.workspaceId).toBe(workspaceId);
    expect('tenantId' in parsed).toBe(false);
  });

  it('strictly rejects AX and page text-like create fields', () => {
    expect(
      CaptureCreateRequestSchema.safeParse({ ...captureCreateRequest, tenantId: workspaceId })
        .success,
    ).toBe(false);
    expect(
      CaptureCreateRequestSchema.safeParse({
        ...captureCreateRequest,
        selectedText: 'Do not upload selected text.',
      }).success,
    ).toBe(false);
    expect(
      CaptureCreateRequestSchema.safeParse({
        ...captureCreateRequest,
        pageBody: 'Do not upload page bodies.',
      }).success,
    ).toBe(false);
    expect(
      CaptureCreateRequestSchema.safeParse({
        ...captureCreateRequest,
        ocrText: 'OCR text is produced by the server, not capture creation.',
      }).success,
    ).toBe(false);
  });
});

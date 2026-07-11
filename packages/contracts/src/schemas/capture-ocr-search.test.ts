import { describe, expect, it } from 'bun:test';
import {
  AXAllowlistDisabledResponseSchema,
  AssetLocationSchema,
  CaptureIngestRequestSchema,
  OcrJobSafeErrorSchema,
  OcrResultSchema,
  SearchDocumentSchema,
  SearchResponseSchema,
} from '../index.js';

const now = '2026-07-06T00:00:00.000Z';
const later = '2026-07-06T00:30:00.000Z';

const ids = {
  workspace: '22222222-2222-4222-8222-222222222222',
  user: '11111111-1111-4111-8111-111111111111',
  capture: '99999999-9999-4999-8999-999999999999',
  asset: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  location: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  timelineEvent: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  searchDocument: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  ocrResult: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
};

const captureIngestRequest = {
  workspaceId: ids.workspace,
  deviceId: 'macbook-pro-01',
  localEventId: 'local-event-01',
  capturedAt: now,
  observedAt: now,
  appName: 'Safari',
  bundleId: 'com.apple.Safari',
  windowTitleCandidate: {
    kind: 'safe',
    value: 'Recapsy design notes',
  },
  urlCandidate: {
    kind: 'safe',
    normalized: 'https://example.test/docs',
    domain: 'example.test',
  },
  documentPathCandidate: {
    kind: 'omitted',
    reason: 'not_available',
  },
  contextFingerprint: 'sha256:context-fingerprint',
  contextConfidence: 'high',
  captureType: 'screen',
  privacyDecision: {
    action: 'allow',
    decidedAt: now,
    policyVersion: 'capture-policy-v1',
    reasons: ['default_allow'],
  },
  idempotencyKey: 'capture-ingest-key-01',
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
  duplicateHint: {
    status: 'unique',
  },
  secureOrPrivateHint: {
    detected: false,
  },
  metadata: {
    helperVersion: '0.1.0',
  },
} as const;

describe('Capture ingest contracts', () => {
  it('parses valid capture ingest requests using workspaceId, not tenantId', () => {
    const parsed = CaptureIngestRequestSchema.parse(captureIngestRequest);

    expect(parsed.workspaceId).toBe(ids.workspace);
    expect('tenantId' in parsed).toBe(false);
  });

  it('strictly rejects AX and page text-like ingest fields', () => {
    expect(
      CaptureIngestRequestSchema.safeParse({
        ...captureIngestRequest,
        tenantId: ids.workspace,
      }).success,
    ).toBe(false);

    expect(
      CaptureIngestRequestSchema.safeParse({
        ...captureIngestRequest,
        selectedText: 'Do not upload selected text.',
      }).success,
    ).toBe(false);

    expect(
      CaptureIngestRequestSchema.safeParse({
        ...captureIngestRequest,
        pageBody: 'Do not upload page bodies.',
      }).success,
    ).toBe(false);

    expect(
      CaptureIngestRequestSchema.safeParse({
        ...captureIngestRequest,
        ocrText: 'OCR text is produced by the server, not capture ingest.',
      }).success,
    ).toBe(false);
  });
});

describe('Asset location contracts', () => {
  it('rejects local_device absolute path leakage fields', () => {
    expect(
      AssetLocationSchema.safeParse({
        id: ids.location,
        workspaceId: ids.workspace,
        assetId: ids.asset,
        kind: 'local_device',
        deviceId: 'macbook-pro-01',
        localDeviceAssetRef: 'local-asset-original-01',
        contentHash: 'sha256:original-hash',
        availability: 'available',
        isAuthoritative: true,
        createdAt: now,
        updatedAt: now,
        localUri: 'file:///Users/example/Pictures/capture.png',
      }).success,
    ).toBe(false);
  });

  it('parses server_temporary locations as non-authoritative with cleanup state', () => {
    const parsed = AssetLocationSchema.parse({
      id: ids.location,
      workspaceId: ids.workspace,
      assetId: ids.asset,
      kind: 'server_temporary',
      temporaryUploadId: 'temporary-upload-01',
      uploadReceipt: 'receipt-01',
      availability: 'available',
      isAuthoritative: false,
      isTemporary: true,
      expiresAt: later,
      cleanupStatus: 'pending',
      createdAt: now,
      updatedAt: now,
    });

    expect(parsed.kind).toBe('server_temporary');
    expect(parsed.isAuthoritative).toBe(false);
  });
});

describe('Search contracts', () => {
  it('allows only screen-text image OCR as search document body source', () => {
    expect(
      SearchDocumentSchema.safeParse({
        id: ids.searchDocument,
        workspaceId: ids.workspace,
        captureId: ids.capture,
        timelineEventId: ids.timelineEvent,
        ocrResultId: ids.ocrResult,
        bodyText: 'Visible OCR text from the screenshot.',
        bodySource: 'screen_text_image_ocr',
        language: 'en',
        bodyHash: 'sha256:body-hash',
        indexStatus: 'indexed',
        embeddingStatus: 'pending',
        indexedAt: now,
        createdAt: now,
        updatedAt: now,
      }).success,
    ).toBe(true);

    expect(
      SearchDocumentSchema.safeParse({
        id: ids.searchDocument,
        workspaceId: ids.workspace,
        captureId: ids.capture,
        timelineEventId: ids.timelineEvent,
        ocrResultId: ids.ocrResult,
        bodyText: 'An activity summary must not be indexed as body text.',
        bodySource: 'activity_summary',
        language: 'en',
        bodyHash: 'sha256:body-hash',
        indexStatus: 'indexed',
        embeddingStatus: 'pending',
        indexedAt: now,
        createdAt: now,
        updatedAt: now,
      }).success,
    ).toBe(false);
  });

  it('requires timelineEventId on search results', () => {
    const response = {
      workspaceId: ids.workspace,
      query: 'visible text',
      modeRequested: 'text',
      modeUsed: 'text',
      indexStatus: 'ready',
      fallbackReason: null,
      results: [
        {
          searchDocumentId: ids.searchDocument,
          timelineEventId: ids.timelineEvent,
          captureId: ids.capture,
          capturedAt: now,
          appName: 'Safari',
          bundleId: 'com.apple.Safari',
          snippet: {
            text: 'Visible <mark>text</mark> from the screenshot.',
            source: 'screen_text_image_ocr',
          },
          score: 0.92,
          indexStatus: 'indexed',
          ocrStatus: 'succeeded',
          syncStatus: 'synced',
          assetAvailability: 'local_device_available',
        },
      ],
      pageInfo: {
        nextCursor: null,
        hasMore: false,
      },
      generatedAt: now,
    } as const;

    expect(SearchResponseSchema.safeParse(response).success).toBe(true);

    const [{ timelineEventId: _timelineEventId, ...resultWithoutTimelineEventId }] =
      response.results;

    expect(
      SearchResponseSchema.safeParse({
        ...response,
        results: [resultWithoutTimelineEventId],
      }).success,
    ).toBe(false);
  });
});

describe('OCR job contracts', () => {
  it('allows empty searchText on OCR results for blank-image successes', () => {
    const parsed = OcrResultSchema.parse({
      id: ids.ocrResult,
      workspaceId: ids.workspace,
      captureId: ids.capture,
      jobId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      resultVersion: 1,
      sourceAssetHash: 'sha256:ocr-input-hash',
      screenText: {
        source: 'image_ocr',
        blocks: [],
        readingOrder: 'top_to_bottom_left_to_right',
      },
      layout: {
        layoutNotes: [],
        visualHints: [],
        detectedTables: 0,
        metadata: {},
      },
      activity: {
        activitySummary: 'Processed screenshot OCR',
        entities: [],
        actionHints: [],
        embeddingCandidateText: 'Processed screenshot OCR',
        metadata: {},
      },
      searchText: '',
      qualityFlags: [],
      createdAt: now,
    });

    expect(parsed.searchText).toBe('');
    expect(parsed.screenText.blocks).toEqual([]);
  });

  it('accepts provider_unavailable as a safe OCR job error code', () => {
    const parsed = OcrJobSafeErrorSchema.parse({
      code: 'provider_unavailable',
      messageSafe: 'OCR provider is temporarily unavailable.',
      retryable: true,
    });

    expect(parsed.code).toBe('provider_unavailable');
    expect(parsed.retryable).toBe(true);
  });
});

describe('AX allowlist contracts', () => {
  it('returns a disabled response with no allowed apps or uploadable fields', () => {
    const parsed = AXAllowlistDisabledResponseSchema.parse({
      workspaceId: ids.workspace,
      enabled: false,
      axTextUploadEnabled: false,
      status: 'disabled',
      reason: 'ax_text_upload_disabled',
      generatedAt: now,
    });

    expect(parsed.enabled).toBe(false);
    expect('allowedApps' in parsed).toBe(false);
    expect('uploadableFields' in parsed).toBe(false);

    expect(
      AXAllowlistDisabledResponseSchema.safeParse({
        workspaceId: ids.workspace,
        enabled: false,
        axTextUploadEnabled: false,
        status: 'disabled',
        reason: 'ax_text_upload_disabled',
        generatedAt: now,
        allowedApps: ['com.apple.Safari'],
      }).success,
    ).toBe(false);
  });
});

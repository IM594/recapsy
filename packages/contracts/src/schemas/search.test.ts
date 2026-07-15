import { describe, expect, it } from 'bun:test';
import { SearchDocumentSchema, SearchRequestSchema, SearchResponseSchema } from '../index.js';

const now = '2026-07-06T00:00:00.000Z';
const ids = {
  workspace: '22222222-2222-4222-8222-222222222222',
  capture: '99999999-9999-4999-8999-999999999999',
  timelineEvent: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  searchDocument: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  ocrResult: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
};

describe('search contracts', () => {
  it('parses search requests without changing their wire shape', () => {
    const parsed = SearchRequestSchema.parse({ workspaceId: ids.workspace, q: 'visible text' });
    expect(parsed).toEqual({
      workspaceId: ids.workspace,
      q: 'visible text',
      mode: 'text',
      allowFallback: true,
      limit: 20,
    });
  });

  it('allows only screen-text image OCR as search document body source', () => {
    const document = {
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
    } as const;
    expect(SearchDocumentSchema.safeParse(document).success).toBe(true);
    expect(
      SearchDocumentSchema.safeParse({ ...document, bodySource: 'activity_summary' }).success,
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
      pageInfo: { nextCursor: null, hasMore: false },
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

import { describe, expect, it } from 'bun:test';
import { OcrResultSchema } from '../index.js';

const now = '2026-07-06T00:00:00.000Z';

describe('OCR result contracts', () => {
  it('allows empty searchText on OCR results for blank-image successes', () => {
    const parsed = OcrResultSchema.parse({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      workspaceId: '22222222-2222-4222-8222-222222222222',
      captureId: '99999999-9999-4999-8999-999999999999',
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
});

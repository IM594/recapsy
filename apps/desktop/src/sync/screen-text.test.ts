import { describe, expect, it } from 'bun:test';
import type { AiOcrResponse } from '@recapsy/contracts';
import { OcrResultInvalidError, mapOcrScreenText } from './screen-text';

function ocrResponse(blocks: AiOcrResponse['blocks']): AiOcrResponse {
  return {
    blocks,
    durationMs: 1200,
    model: 'test-model',
    providerName: 'test-provider',
    text: blocks.map((block) => block.text).join('\n'),
  };
}

describe('mapOcrScreenText', () => {
  it('maps blocks with source, reading order, kind, and bounding box', () => {
    const result = mapOcrScreenText(
      ocrResponse([
        { bbox: { height: 10, width: 20, x: 1, y: 2 }, kind: 'heading', order: 0, text: 'Title' },
        { kind: 'code', order: 1, text: 'const a = 1;' },
      ]),
    );

    expect(result.source).toBe('image_ocr');
    expect(result.readingOrder).toBe('top_to_bottom_left_to_right');
    expect(result.blocks).toEqual([
      {
        bbox: { height: 10, width: 20, x: 1, y: 2 },
        kind: 'heading',
        readingOrder: 0,
        source: 'image_ocr',
        text: 'Title',
      },
      { kind: 'code', readingOrder: 1, source: 'image_ocr', text: 'const a = 1;' },
    ]);
  });

  it('drops empty and whitespace-only blocks while keeping the original index as reading order', () => {
    const result = mapOcrScreenText(
      ocrResponse([{ text: 'first' }, { text: '   ' }, { text: '' }, { text: 'fourth' }]),
    );

    expect(result.blocks.map((block) => block.text)).toEqual(['first', 'fourth']);
    // The surviving blocks keep their original array indices as reading order,
    // so the dropped middle blocks leave a gap (0, then 3) rather than renumber.
    expect(result.blocks.map((block) => block.readingOrder)).toEqual([0, 3]);
  });

  it('defaults a missing kind to text and folds unknown kinds to other', () => {
    const result = mapOcrScreenText(
      ocrResponse([
        { text: 'no kind' },
        { kind: 'paragraph', text: 'unknown kind' },
        { kind: 'label', text: 'known kind' },
      ]),
    );

    expect(result.blocks.map((block) => block.kind)).toEqual(['text', 'other', 'label']);
  });

  it('prefers an explicit order of zero over the array index', () => {
    const result = mapOcrScreenText(
      ocrResponse([
        { order: 5, text: 'later' },
        { order: 0, text: 'earlier' },
      ]),
    );

    expect(result.blocks.map((block) => block.readingOrder)).toEqual([5, 0]);
  });

  it('drops a zero-area bounding box but keeps the block', () => {
    const result = mapOcrScreenText(
      ocrResponse([
        { bbox: { height: 0, width: 20, x: 1, y: 2 }, text: 'zero height' },
        { bbox: { height: 10, width: 0, x: 1, y: 2 }, text: 'zero width' },
      ]),
    );

    expect(result.blocks).toHaveLength(2);
    expect(result.blocks.every((block) => block.bbox === undefined)).toBe(true);
  });

  it('throws OcrResultInvalidError when no block has any text', () => {
    expect(() => mapOcrScreenText(ocrResponse([{ text: '' }, { text: '  ' }]))).toThrow(
      OcrResultInvalidError,
    );
  });

  it('throws OcrResultInvalidError for an empty block list', () => {
    expect(() => mapOcrScreenText(ocrResponse([]))).toThrow(OcrResultInvalidError);
  });
});

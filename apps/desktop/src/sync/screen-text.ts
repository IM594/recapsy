import {
  type AiOcrResponse,
  type OcrScreenTextBlock,
  type OcrScreenTextBlockKind,
  type OcrScreenTextResult,
  OcrScreenTextResultSchema,
} from '@recapsy/contracts';

/**
 * Raised when an `AiOcrResponse` cannot be mapped to a valid screen-text
 * result — either no non-empty block survives, or the assembled shape fails
 * `OcrScreenTextResultSchema`. The proxy transcript is deterministic input, so
 * re-mapping the same bytes would fail identically; the sync scheduler treats
 * this as `result_invalid` and retries by re-running the proxy for a fresh
 * provider response, not by re-mapping. See
 * `docs/design/OCR_OUTBOX_STATE_MACHINE.md` §3.2.
 */
export class OcrResultInvalidError extends Error {
  readonly code = 'result_invalid';

  constructor(message = 'OCR response produced no valid screen-text blocks.') {
    super(message);
    this.name = 'OcrResultInvalidError';
  }
}

const KNOWN_SCREEN_TEXT_KINDS = new Set<OcrScreenTextBlockKind>([
  'text',
  'heading',
  'label',
  'table_cell',
  'code',
  'other',
]);

/**
 * Maps the proxy OCR response to the persisted screen-text shape, applying the
 * mapping rules from `OCR_OUTBOX_STATE_MACHINE.md`'s appendix:
 * - `source` is the constant `'image_ocr'`.
 * - Blocks whose text is empty/whitespace are dropped (screen-text `text`
 *   requires `min(1)`; the proxy schema allows an empty string).
 * - `readingOrder` is the block's own `order`, or its original array index.
 * - `kind` maps the free-form proxy kind onto the screen-text enum; unknown
 *   values become `other`, a missing value defaults to `text`.
 * - A zero-area bounding box is dropped (screen-text requires positive
 *   width/height) rather than failing the whole block; a missing box stays
 *   absent.
 *
 * Throws {@link OcrResultInvalidError} when nothing valid remains.
 */
export function mapOcrScreenText(response: AiOcrResponse): OcrScreenTextResult {
  const blocks: OcrScreenTextBlock[] = [];

  response.blocks.forEach((block, index) => {
    if (block.text.trim().length === 0) {
      return;
    }

    const bbox = normalizeBoundingBox(block.bbox);

    blocks.push({
      kind: normalizeKind(block.kind),
      readingOrder: block.order ?? index,
      source: 'image_ocr',
      text: block.text,
      ...(bbox ? { bbox } : {}),
    });
  });

  if (blocks.length === 0) {
    throw new OcrResultInvalidError();
  }

  const parsed = OcrScreenTextResultSchema.safeParse({
    blocks,
    readingOrder: 'top_to_bottom_left_to_right',
    source: 'image_ocr',
  });

  if (!parsed.success) {
    throw new OcrResultInvalidError('Mapped screen-text result failed schema validation.');
  }

  return parsed.data;
}

function normalizeKind(kind: string | undefined): OcrScreenTextBlockKind {
  if (!kind) {
    return 'text';
  }

  return KNOWN_SCREEN_TEXT_KINDS.has(kind as OcrScreenTextBlockKind)
    ? (kind as OcrScreenTextBlockKind)
    : 'other';
}

function normalizeBoundingBox(
  bbox: AiOcrResponse['blocks'][number]['bbox'],
): OcrScreenTextBlock['bbox'] | undefined {
  if (!bbox) {
    return undefined;
  }

  // Proxy boxes allow zero width/height; the screen-text box requires both
  // positive. Drop a degenerate box instead of failing the block it annotates.
  if (bbox.width <= 0 || bbox.height <= 0) {
    return undefined;
  }

  return { height: bbox.height, width: bbox.width, x: bbox.x, y: bbox.y };
}

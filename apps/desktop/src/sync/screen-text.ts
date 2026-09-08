import {
  type AiOcrResponse,
  type OcrActivityResult,
  OcrActivityResultSchema,
  type OcrActivityStatus,
  type OcrQualityFlag,
  type OcrScreenTextBlock,
  type OcrScreenTextBlockKind,
  type OcrScreenTextResult,
  OcrScreenTextResultSchema,
} from '@recapsy/contracts';

/**
 * Raised when an `AiOcrResponse` cannot be mapped to a valid screen-text
 * result because the assembled shape fails `OcrScreenTextResultSchema`. The
 * proxy transcript is deterministic input, so
 * re-mapping the same bytes would fail identically; the sync job executor treats
 * this as `result_invalid` and retries by re-running the proxy for a fresh
 * provider response, not by re-mapping. See
 * `docs/design/OCR_OUTBOX_STATE_MACHINE.md` §3.2.
 */
export class OcrResultInvalidError extends Error {
  readonly code = 'result_invalid';

  constructor(message = 'Mapped screen-text result failed schema validation.') {
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
 * An empty block list is valid: an image without visible text is a successful
 * OCR result that must still be submitted for server-side success auditing.
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

/**
 * Real facts about this transcript's fidelity, derived from the provider
 * response at OCR time rather than fabricated later. Today this only reads
 * `completion.stopReason`: a provider that hit its output-token ceiling kept
 * the partial transcript (not discarded) but it is incomplete, so the
 * desktop marks it `truncated`. `blurred`/`partial_capture` would need frame
 * quality signals from the Swift capture layer that are not yet threaded
 * through this proxy response — left for when that signal exists rather than
 * guessed at here.
 */
export function deriveOcrQualityFlags(response: AiOcrResponse): OcrQualityFlag[] {
  const flags: OcrQualityFlag[] = [];

  if (response.completion?.stopReason === 'output_truncated') {
    flags.push('truncated');
  }

  return flags;
}

export function mapOcrActivity(response: AiOcrResponse): {
  activity: OcrActivityResult;
  status: OcrActivityStatus;
} {
  const status = response.activityStatus;
  const parsed = OcrActivityResultSchema.safeParse({
    activitySummary: response.activity.activitySummary ?? null,
    actionHints: response.activity.actionHints,
    embeddingCandidateText: response.activity.embeddingCandidateText ?? null,
    entities: response.activity.entities,
    metadata: { observationStatus: status },
  });

  if (!parsed.success) {
    return {
      activity: emptyOcrActivity('invalid'),
      status: 'invalid',
    };
  }

  return { activity: parsed.data, status };
}

function emptyOcrActivity(status: OcrActivityStatus): OcrActivityResult {
  return {
    activitySummary: null,
    actionHints: [],
    embeddingCandidateText: null,
    entities: [],
    metadata: { observationStatus: status },
  };
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

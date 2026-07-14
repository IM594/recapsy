import type { HelperEnvelope, HelperProtocolErrorCode, HelperProtocolResult } from './types';
import type { HelperEnvelopeValidator } from './validation';

export const HELPER_PROTOCOL_MAX_LINE_LENGTH = 1024 * 1024;

export function encodeHelperEnvelope(envelope: HelperEnvelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

export function decodeHelperEnvelopeLine<TEnvelope extends HelperEnvelope>(
  line: string,
  validateEnvelope: HelperEnvelopeValidator<TEnvelope>,
  maxLineLength = HELPER_PROTOCOL_MAX_LINE_LENGTH,
): HelperProtocolResult<TEnvelope> {
  if (line.length > maxLineLength) {
    return codecError('schema_mismatch', 'Helper protocol line exceeds the size limit.');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    return codecError('invalid_json', 'Helper protocol line is not valid JSON.');
  }

  return validateEnvelope(decoded);
}

export function parseHelperNdjsonChunk<TEnvelope extends HelperEnvelope>(
  chunk: string,
  validateEnvelope: HelperEnvelopeValidator<TEnvelope>,
  maxLineLength = HELPER_PROTOCOL_MAX_LINE_LENGTH,
): HelperProtocolResult<TEnvelope>[] {
  return new HelperNdjsonLineParser(validateEnvelope, maxLineLength).feed(chunk);
}

export class HelperNdjsonLineParser<TEnvelope extends HelperEnvelope> {
  private buffer = '';
  private discardingOversizedLine = false;

  constructor(
    private readonly validateEnvelope: HelperEnvelopeValidator<TEnvelope>,
    private readonly maxLineLength = HELPER_PROTOCOL_MAX_LINE_LENGTH,
  ) {}

  feed(input: string): HelperProtocolResult<TEnvelope>[] {
    const results: HelperProtocolResult<TEnvelope>[] = [];
    let chunk = input;

    if (this.discardingOversizedLine) {
      const lineBreak = findFirstLineBreak(chunk);
      if (!lineBreak) return results;
      chunk = chunk.slice(lineBreak.index + lineBreak.length);
      this.discardingOversizedLine = false;
    }

    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim().length > 0) {
        results.push(decodeHelperEnvelopeLine(line, this.validateEnvelope, this.maxLineLength));
      }
    }

    if (this.buffer.length > this.maxLineLength) {
      this.buffer = '';
      this.discardingOversizedLine = true;
      results.push(codecError('schema_mismatch', 'Helper protocol line exceeds the size limit.'));
    }

    return results;
  }

  flush(): HelperProtocolResult<TEnvelope>[] {
    if (this.discardingOversizedLine) {
      this.discardingOversizedLine = false;
      return [];
    }

    if (this.buffer.trim().length === 0) {
      this.buffer = '';
      return [];
    }

    const line = this.buffer;
    this.buffer = '';
    return [decodeHelperEnvelopeLine(line, this.validateEnvelope, this.maxLineLength)];
  }
}

function codecError<TEnvelope extends HelperEnvelope>(
  code: HelperProtocolErrorCode,
  message: string,
): HelperProtocolResult<TEnvelope> {
  return { error: { code, message }, ok: false };
}

function findFirstLineBreak(value: string): { index: number; length: number } | null {
  const newlineIndex = value.indexOf('\n');
  if (newlineIndex < 0) return null;
  return {
    index: newlineIndex > 0 && value[newlineIndex - 1] === '\r' ? newlineIndex - 1 : newlineIndex,
    length: newlineIndex > 0 && value[newlineIndex - 1] === '\r' ? 2 : 1,
  };
}

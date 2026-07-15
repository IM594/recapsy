import { describe, expect, it } from 'bun:test';
import {
  HelperNdjsonLineParser,
  decodeHelperEnvelopeLine,
  encodeHelperEnvelope,
  parseHelperNdjsonChunk,
} from '../codec';
import { HELPER_PROTOCOL_VERSION, type HelperEnvelope } from '../types';
import { validateHelperToMainEnvelope } from '../validation';

const hello: HelperEnvelope<'helper.hello'> = {
  correlationId: null,
  messageId: 'hello_1',
  payload: {
    capabilities: { capture: true, mock: true, permissions: false },
    helperVersion: 'helper/1.0.0',
    pid: 42,
  },
  protocolVersion: HELPER_PROTOCOL_VERSION,
  sentAt: '2026-07-15T00:00:00.000Z',
  type: 'helper.hello',
};

describe('helper protocol codec', () => {
  it('encodes one envelope as exactly one newline-terminated NDJSON line', () => {
    const line = encodeHelperEnvelope(hello);

    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    expect(JSON.parse(line)).toEqual(hello);
  });

  it('decodes a complete line with an explicitly bound direction validator', () => {
    expect(decodeHelperEnvelopeLine(JSON.stringify(hello), validateHelperToMainEnvelope)).toEqual({
      envelope: hello,
      ok: true,
    });
  });

  it('buffers split chunks, parses multiple CRLF lines, and ignores blank lines', () => {
    const parser = new HelperNdjsonLineParser(validateHelperToMainEnvelope);
    const line = encodeHelperEnvelope(hello);
    const splitAt = Math.floor(line.length / 2);

    expect(parser.feed(line.slice(0, splitAt))).toEqual([]);
    expect(parser.feed(`${line.slice(splitAt).trimEnd()}\r\n\r\n${line}`)).toEqual([
      { envelope: hello, ok: true },
      { envelope: hello, ok: true },
    ]);
  });

  it('flushes a final line without a trailing newline exactly once', () => {
    const parser = new HelperNdjsonLineParser(validateHelperToMainEnvelope);
    parser.feed(JSON.stringify(hello));

    expect(parser.flush()).toEqual([{ envelope: hello, ok: true }]);
    expect(parser.flush()).toEqual([]);
  });

  it('parses a complete chunk through the supplied direction validator', () => {
    expect(
      parseHelperNdjsonChunk(encodeHelperEnvelope(hello), validateHelperToMainEnvelope),
    ).toEqual([{ envelope: hello, ok: true }]);
  });

  it('classifies invalid JSON without exposing the raw line', () => {
    const result = decodeHelperEnvelopeLine(
      '{"providerToken":"secret-token"',
      validateHelperToMainEnvelope,
    );

    expect(result).toEqual({
      error: { code: 'invalid_json', message: 'Helper protocol line is not valid JSON.' },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain('secret-token');
    expect(JSON.stringify(result)).not.toContain('providerToken');
  });

  it('returns the validator safe error without echoing a rejected payload', () => {
    const result = decodeHelperEnvelopeLine(
      JSON.stringify({
        ...hello,
        payload: { localPath: '/Users/alice/private.png', providerToken: 'secret-token' },
        type: 'capture.result',
      }),
      validateHelperToMainEnvelope,
    );

    expect(result).toMatchObject({ error: { code: 'schema_mismatch' }, ok: false });
    expect(JSON.stringify(result)).not.toContain('/Users/alice');
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('bounds an unfinished line and resumes only after discarding through its newline', () => {
    const parser = new HelperNdjsonLineParser(validateHelperToMainEnvelope, 512);

    expect(parser.feed('x'.repeat(513))).toEqual([
      {
        error: {
          code: 'schema_mismatch',
          message: 'Helper protocol line exceeds the size limit.',
        },
        ok: false,
      },
    ]);
    expect(parser.feed(`discarded remainder\n${encodeHelperEnvelope(hello)}`)).toEqual([
      { envelope: hello, ok: true },
    ]);
  });
});

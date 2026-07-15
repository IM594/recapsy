import { describe, expect, it } from 'bun:test';
import type { ServerApiTransportRequest } from '../../server/index';
import { createHttpTransport } from '../http-transport';

const request = (body?: unknown): ServerApiTransportRequest => ({
  body,
  headers: {},
  method: 'POST',
  path: '/v1/test',
  query: {},
  url: new URL('https://example.test/v1/test'),
});

describe('HTTP server transport', () => {
  it('encodes JSON, adds its content type, and decodes JSON responses', async () => {
    let received: RequestInit | undefined;
    const transport = createHttpTransport({
      fetch: async (_input, init) => {
        received = init;
        return Response.json({ ok: true }, { status: 201 });
      },
    });

    const response = await transport(request({ name: 'capture' }));

    expect(received?.body).toBe('{"name":"capture"}');
    expect(new Headers(received?.headers).get('content-type')).toBe('application/json');
    expect(response).toMatchObject({ body: { ok: true }, status: 201 });
  });

  it('preserves binary bytes and an explicit content type', async () => {
    let received: RequestInit | undefined;
    const transport = createHttpTransport({
      fetch: async (_input, init) => {
        received = init;
        return new Response(null, { status: 204 });
      },
    });
    const binaryRequest = request(new Uint8Array([0, 1, 255]));
    binaryRequest.headers['content-type'] = 'image/png';

    const response = await transport(binaryRequest);

    expect(Array.from(new Uint8Array(received?.body as ArrayBuffer))).toEqual([0, 1, 255]);
    expect(new Headers(received?.headers).get('content-type')).toBe('image/png');
    expect(response.body).toBeUndefined();
  });

  it('wraps non-empty text and maps empty text to an absent body', async () => {
    const responses = [
      new Response('temporarily unavailable', { status: 503 }),
      new Response('', { status: 200 }),
    ];
    const transport = createHttpTransport({
      fetch: async () => responses.shift() as Response,
    });

    expect((await transport(request())).body).toEqual({ text: 'temporarily unavailable' });
    expect((await transport(request())).body).toBeUndefined();
  });
});

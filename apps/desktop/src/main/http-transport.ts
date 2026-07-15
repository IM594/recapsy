import type { ServerApiTransport } from '../server/index';

export type HttpFetch = (input: URL, init: RequestInit) => Promise<Response>;

export type HttpTransportOptions = {
  fetch?: HttpFetch;
};

export function createHttpTransport(options: HttpTransportOptions = {}): ServerApiTransport {
  const fetchRequest = options.fetch ?? globalThis.fetch;

  return async (request) => {
    const headers = new Headers(request.headers);
    const response = await fetchRequest(request.url, {
      body: encodeTransportBody(request.body, headers),
      headers,
      method: request.method,
    });

    return {
      body: await decodeTransportBody(response),
      headers: Object.fromEntries(response.headers.entries()),
      status: response.status,
    };
  };
}

function encodeTransportBody(body: unknown, headers: Headers): BodyInit | undefined {
  if (body === undefined) {
    return undefined;
  }

  if (body instanceof Uint8Array) {
    const buffer = new ArrayBuffer(body.byteLength);
    new Uint8Array(buffer).set(body);
    return buffer;
  }

  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  return JSON.stringify(body);
}

async function decodeTransportBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }

  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    return await response.json();
  }

  const text = await response.text();
  return text ? { text } : undefined;
}

import { describe, expect, it } from 'bun:test';
import { parseDesktopConfig } from '../config';

describe('desktop runtime config', () => {
  it('fails closed when the server endpoint is missing', () => {
    const result = parseDesktopConfig({ env: {} });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'server_endpoint_required',
        message: 'Server endpoint is required to start the desktop runtime.',
      },
    });
  });

  it('loads the server endpoint from explicit input before environment', () => {
    const result = parseDesktopConfig({
      serverEndpoint: 'https://configured.example.test',
      env: {
        RECAPSY_SERVER_ENDPOINT: 'https://env.example.test',
      },
    });

    expect(result).toEqual({
      ok: true,
      config: {
        serverEndpoint: 'https://configured.example.test/',
      },
    });
  });
});

import { describe, expect, it } from 'bun:test';
import { startLoopbackHttpServer } from './loopback-http-server';

describe('loopback HTTP test server', () => {
  it('binds only to loopback and becomes unavailable after stop', async () => {
    const server = startLoopbackHttpServer(() => new Response('ok'));
    let stopped = false;

    try {
      expect(new URL(server.endpoint).hostname).toBe('127.0.0.1');
      expect(await (await fetch(server.endpoint)).text()).toBe('ok');

      server.stop();
      stopped = true;

      await expect(fetch(server.endpoint)).rejects.toThrow();
    } finally {
      if (!stopped) {
        server.stop();
      }
    }
  });
});

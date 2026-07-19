type HttpFetchHandler = (request: Request) => Response | Promise<Response>;

export type LoopbackHttpServer = {
  endpoint: string;
  stop(): void;
};

export function startLoopbackHttpServer(fetch: HttpFetchHandler): LoopbackHttpServer {
  let server: ReturnType<typeof Bun.serve> | undefined;

  try {
    server = Bun.serve({
      fetch,
      hostname: '127.0.0.1',
      port: 0,
    });

    return {
      endpoint: server.url.toString().replace(/\/$/, ''),
      stop() {
        server?.stop(true);
        server = undefined;
      },
    };
  } catch (error) {
    server?.stop(true);
    throw error;
  }
}

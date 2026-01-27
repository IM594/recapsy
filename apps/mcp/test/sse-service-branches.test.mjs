import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";

import { createSseService } from "../src/sse-service.mjs";

class MockResponse extends Writable {
  statusCode = null;
  headers = {};
  #chunks = [];

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = { ...this.headers, ...(headers ?? {}) };
    return this;
  }

  _write(chunk, _encoding, callback) {
    this.#chunks.push(Buffer.from(chunk));
    callback();
  }

  bodyText() {
    return Buffer.concat(this.#chunks).toString("utf8");
  }
}

function makeRequest({ method, url, headers, body } = {}) {
  const stream = body == null ? Readable.from([]) : Readable.from([Buffer.from(body)]);
  stream.method = method;
  stream.url = url;
  stream.headers = headers ?? {};
  return stream;
}

async function runToFinish(handler, req) {
  const res = new MockResponse();
  const done = once(res, "finish");
  await handler(req, res);
  await done;
  return res;
}

function runNoFinish(handler, req) {
  const res = new MockResponse();
  return handler(req, res).then(() => res);
}

function parseJsonText(text) {
  return JSON.parse(String(text));
}

test("sse-service: token from query + tokenTailHint branches", async () => {
  const warns = [];
  const logger = { warn: (msg) => warns.push(String(msg)), log() {}, error() {} };

  const sse = createSseService({
    host: "127.0.0.1",
    token: "secret",
    keepAliveSeconds: 999,
    logger,
    handleRequest: async () => null,
    startKeepAliveTimer: () => ({ unref() {} }),
    clearKeepAliveTimer: () => {},
  });

  // no token -> unauthorized + hint "(none)"
  {
    const res = await runToFinish(sse.handler, makeRequest({
      method: "GET",
      url: "/sse",
      headers: { host: "127.0.0.1" },
    }));
    assert.equal(res.statusCode, 401);
    assert.ok(warns.some((w) => w.includes("(none)")));
  }

  // short token -> unauthorized + hint "****"
  {
    const res = await runToFinish(sse.handler, makeRequest({
      method: "GET",
      url: "/sse",
      headers: { host: "127.0.0.1", authorization: "Bearer a" },
    }));
    assert.equal(res.statusCode, 401);
    assert.ok(warns.some((w) => w.includes("****")));
  }

  // long token -> unauthorized + hint tail digits
  {
    const res = await runToFinish(sse.handler, makeRequest({
      method: "GET",
      url: "/sse",
      headers: { host: "127.0.0.1", authorization: "Bearer 0123456789" },
    }));
    assert.equal(res.statusCode, 401);
    assert.ok(warns.some((w) => w.includes("****456789")));
  }

  // query token -> authorized
  {
    const res = await runNoFinish(sse.handler, makeRequest({
      method: "GET",
      url: "/sse?token=secret",
      headers: { host: "127.0.0.1" },
    }));
    assert.equal(res.statusCode, 200);
    assert.match(res.bodyText(), /event: endpoint/);
    res.end();
  }
});

test("sse-service: /message routes to single session when sessionId omitted but token provided", async () => {
  const token = "secret";
  const sse = createSseService({
    host: "127.0.0.1",
    token,
    keepAliveSeconds: 999,
    logger: { warn() {}, log() {}, error() {} },
    handleRequest: async (message) => {
      return { jsonrpc: "2.0", id: message?.id ?? null, result: { ok: true } };
    },
    startKeepAliveTimer: () => ({ unref() {} }),
    clearKeepAliveTimer: () => {},
  });

  const sseRes = await runNoFinish(sse.handler, makeRequest({
    method: "GET",
    url: "/sse?token=secret",
    headers: { host: "127.0.0.1" },
  }));
  assert.equal(sseRes.statusCode, 200);
  assert.equal(sse.sessions.size, 1);

  const res = await runToFinish(sse.handler, makeRequest({
    method: "POST",
    url: "/message",
    headers: { host: "127.0.0.1", authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  }));
  assert.equal(res.statusCode, 202);
  assert.match(sseRes.bodyText(), /event: message/);

  sseRes.end();
});

test("sse-service: readJson 413 when body too large", async () => {
  const token = "secret";
  const sse = createSseService({
    host: "127.0.0.1",
    token,
    keepAliveSeconds: 999,
    logger: { warn() {}, log() {}, error() {} },
    handleRequest: async () => null,
    generateSessionId: () => "session-1",
    startKeepAliveTimer: () => ({ unref() {} }),
    clearKeepAliveTimer: () => {},
  });

  await runNoFinish(sse.handler, makeRequest({
    method: "GET",
    url: "/sse",
    headers: { host: "127.0.0.1", authorization: `Bearer ${token}` },
  }));

  const payload = JSON.stringify({ x: "a".repeat(1_000_100) });
  const res = await runToFinish(sse.handler, makeRequest({
    method: "POST",
    url: "/message?sessionId=session-1",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: payload,
  }));
  assert.equal(res.statusCode, 413);
  const body = parseJsonText(res.bodyText());
  assert.equal(body.error, "Request body too large");
});

test("sse-service: /shutdown swallows onShutdown errors", async () => {
  const token = "secret";
  const sse = createSseService({
    host: "127.0.0.1",
    token,
    keepAliveSeconds: 999,
    logger: { warn() {}, log() {}, error() {} },
    handleRequest: async () => null,
    onShutdown: () => {
      throw new Error("shutdown boom");
    },
    startKeepAliveTimer: () => ({ unref() {} }),
    clearKeepAliveTimer: () => {},
  });

  const res = await runToFinish(sse.handler, makeRequest({
    method: "POST",
    url: "/shutdown",
    headers: { host: "127.0.0.1", authorization: `Bearer ${token}` },
  }));
  assert.equal(res.statusCode, 202);
});

test("sse-service: req close clears session even if clearKeepAliveTimer throws", async () => {
  const token = "secret";
  const sse = createSseService({
    host: "127.0.0.1",
    token,
    keepAliveSeconds: 999,
    logger: { warn() {}, log() {}, error() {} },
    handleRequest: async () => null,
    generateSessionId: () => "session-1",
    startKeepAliveTimer: () => ({ unref() {} }),
    clearKeepAliveTimer: () => {
      throw new Error("clear boom");
    },
  });

  const req = makeRequest({
    method: "GET",
    url: "/sse",
    headers: { host: "127.0.0.1", authorization: `Bearer ${token}` },
  });
  const res = await runNoFinish(sse.handler, req);
  assert.ok(sse.sessions.has("session-1"));
  req.emit("close");
  assert.ok(!sse.sessions.has("session-1"));
  res.end();
});

test("sse-service: default keepalive timer ignores res.write errors", async () => {
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn) => {
    fn();
    return { unref() {} };
  };

  try {
    const token = "secret";
    const sse = createSseService({
      host: "127.0.0.1",
      token,
      keepAliveSeconds: 1,
      logger: { warn() {}, log() {}, error() {} },
      handleRequest: async () => null,
      clearKeepAliveTimer: () => {},
    });

    const req = makeRequest({
      method: "GET",
      url: "/sse?token=secret",
      headers: { host: "127.0.0.1" },
    });

    const res = new MockResponse();
    const originalWrite = res.write.bind(res);
    res.write = (chunk, ...rest) => {
      if (String(chunk).startsWith(": keepalive")) {
        throw new Error("write boom");
      }
      return originalWrite(chunk, ...rest);
    };

    await sse.handler(req, res);
    assert.equal(res.statusCode, 200);
    res.end();
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
});

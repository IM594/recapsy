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

test("mcp-sse handler: /sse + /message 授权与路由（无端口监听）", async () => {
  const token = "test-token";

  const sse = createSseService({
    host: "127.0.0.1",
    token,
    keepAliveSeconds: 999,
    logger: { log() {}, warn() {}, error() {} },
    handleRequest: async (message) => {
      if (!message) return null;
      return { jsonrpc: "2.0", id: message.id ?? null, result: { ok: true } };
    },
    generateSessionId: () => "session-1",
    startKeepAliveTimer: () => ({ unref() {} }),
    clearKeepAliveTimer: () => {},
  });

  // 未授权 /sse：401
  {
    const res = await runToFinish(sse.handler, makeRequest({
      method: "GET",
      url: "/sse",
      headers: { host: "127.0.0.1" },
    }));
    assert.equal(res.statusCode, 401);
    const body = parseJsonText(res.bodyText());
    assert.equal(body.error, "Unauthorized");
  }

  // 授权 /sse：返回 endpoint，并注册 session
  const sseRes = await runNoFinish(sse.handler, makeRequest({
    method: "GET",
    url: "/sse",
    headers: { host: "127.0.0.1", authorization: `Bearer ${token}` },
  }));
  assert.equal(sseRes.statusCode, 200);
  assert.match(String(sseRes.headers["Content-Type"] ?? ""), /text\/event-stream/);
  assert.ok(sse.sessions.has("session-1"));
  assert.match(sseRes.bodyText(), /: connected/);
  assert.match(sseRes.bodyText(), /event: endpoint/);
  assert.ok(sseRes.bodyText().includes("data: /message?sessionId=session-1"));

  // 未授权 /message：401（既无 token，也无有效 sessionId）
  {
    const res = await runToFinish(sse.handler, makeRequest({
      method: "POST",
      url: "/message",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    assert.equal(res.statusCode, 401);
    const body = parseJsonText(res.bodyText());
    assert.equal(body.error, "Unauthorized");
  }

  // 仅带 sessionId（无 token）也允许发消息，并会通过 SSE 回 message event
  {
    const res = await runToFinish(sse.handler, makeRequest({
      method: "POST",
      url: "/message?sessionId=session-1",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "ping" }),
    }));
    assert.equal(res.statusCode, 202);
    const body = parseJsonText(res.bodyText());
    assert.equal(body.ok, true);
    assert.match(sseRes.bodyText(), /event: message/);
    assert.match(sseRes.bodyText(), /\"id\":42/);
  }

  // req close：应清理 session
  {
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
  }
});

test("mcp-sse handler: /shutdown 需 token 并触发回调", async () => {
  const token = "test-token";
  let shutdownCalled = 0;

  const sse = createSseService({
    host: "127.0.0.1",
    token,
    keepAliveSeconds: 999,
    logger: { log() {}, warn() {}, error() {} },
    handleRequest: async () => null,
    onShutdown: () => {
      shutdownCalled += 1;
    },
    startKeepAliveTimer: () => ({ unref() {} }),
    clearKeepAliveTimer: () => {},
  });

  {
    const res = await runToFinish(sse.handler, makeRequest({
      method: "POST",
      url: "/shutdown",
      headers: { host: "127.0.0.1" },
    }));
    assert.equal(res.statusCode, 401);
    const body = parseJsonText(res.bodyText());
    assert.equal(body.error, "Unauthorized");
    assert.equal(shutdownCalled, 0);
  }

  {
    const res = await runToFinish(sse.handler, makeRequest({
      method: "POST",
      url: "/shutdown",
      headers: { host: "127.0.0.1", authorization: `Bearer ${token}` },
    }));
    assert.equal(res.statusCode, 202);
    const body = parseJsonText(res.bodyText());
    assert.equal(body.ok, true);
    assert.equal(shutdownCalled, 1);
  }
});

test("mcp-sse handler: /health, unknown routes, invalid JSON, unknown session", async () => {
  const token = "test-token";

  const sse = createSseService({
    host: "127.0.0.1",
    token,
    keepAliveSeconds: 999,
    logger: { log() {}, warn() {}, error() {} },
    handleRequest: async () => ({ ok: true }),
    generateSessionId: () => "session-1",
    startKeepAliveTimer: () => ({ unref() {} }),
    clearKeepAliveTimer: () => {},
  });

  {
    const res = await runToFinish(sse.handler, makeRequest({
      method: "GET",
      url: "/health",
      headers: { host: "127.0.0.1" },
    }));
    assert.equal(res.statusCode, 200);
    const body = parseJsonText(res.bodyText());
    assert.equal(body.ok, true);
  }

  {
    const res = await runToFinish(sse.handler, makeRequest({
      method: "GET",
      url: "/nope",
      headers: { host: "127.0.0.1" },
    }));
    assert.equal(res.statusCode, 404);
  }

  // /message unknown sessionId
  {
    const res = await runToFinish(sse.handler, makeRequest({
      method: "POST",
      url: "/message?sessionId=missing",
      headers: {
        host: "127.0.0.1",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    }));
    assert.equal(res.statusCode, 404);
    const body = parseJsonText(res.bodyText());
    assert.equal(body.error, "Unknown session");
  }

  // /message invalid json
  {
    await runNoFinish(sse.handler, makeRequest({
      method: "GET",
      url: "/sse",
      headers: { host: "127.0.0.1", authorization: `Bearer ${token}` },
    }));

    const res = await runToFinish(sse.handler, makeRequest({
      method: "POST",
      url: "/message?sessionId=session-1",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: "{",
    }));
    assert.equal(res.statusCode, 400);
    const body = parseJsonText(res.bodyText());
    assert.equal(body.error, "Invalid JSON");
  }
});

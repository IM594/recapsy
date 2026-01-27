import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createSseService } from "../src/sse-service.mjs";
import { canListenTcp, getAvailablePort } from "../test-utils/tcp.mjs";

const canListen = await canListenTcp();

function startServer(handler, { host, port }) {
  const server = http.createServer(handler);
  const sockets = new Set();

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve({ server, sockets }));
  });
}

async function readUntil(reader, buffer, predicate, { timeoutMs = 3000 } = {}) {
  const startedAt = Date.now();
  let text = buffer ?? "";

  if (predicate(text)) return text;

  const readWithTimeout = async () => {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) return { timedOut: true };

    return Promise.race([
      reader.read().then((result) => ({ result })),
      new Promise((resolve) => {
        setTimeout(() => resolve({ timedOut: true }), remainingMs);
      }),
    ]);
  };

  while (Date.now() - startedAt < timeoutMs) {
    const outcome = await readWithTimeout();
    if (outcome.timedOut) break;

    const { value, done } = outcome.result;
    if (done) break;
    text += Buffer.from(value).toString("utf8");
    if (predicate(text)) return text;
  }

  throw new Error(
    `timeout waiting for sse content, got=${JSON.stringify(text.slice(0, 200))}`
  );
}

function extractSessionId(sseText) {
  const match = sseText.match(/\/message\?sessionId=([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

test(
  "TEST-3b: MCP SSE 真实端口 E2E（/sse + /message）",
  { skip: canListen ? false : "当前环境不允许 net.listen，跳过真实端口 E2E" },
  async (t) => {
    const host = "127.0.0.1";
    const port = await getAvailablePort({ host });
    const baseUrl = `http://${host}:${port}`;
    const token = "test-token";

    const sse = createSseService({
      token,
      keepAliveSeconds: 1,
      handleRequest: async (message) => ({
        ok: true,
        echo: message ?? null,
      }),
    });

    const controller = new AbortController();
    let reader = null;

    const { server, sockets } = await startServer(sse.handler, { host, port });
    t.after(async () => {
      try {
        controller.abort();
      } catch {
        // ignore
      }

      try {
        await reader?.cancel();
      } catch {
        // ignore
      }

      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      }

      await new Promise((resolve) => server.close(resolve));
    });

    const res = await fetch(`${baseUrl}/sse?token=${token}`, {
      method: "GET",
      signal: controller.signal,
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.ok(res.body, "SSE response should have a body");

    reader = res.body.getReader();
    let buffer = "";

    buffer = await readUntil(reader, buffer, (txt) => txt.includes("event: endpoint\n"), {
      timeoutMs: 3000,
    });

    const sessionId = extractSessionId(buffer);
    assert.ok(sessionId, `expected sessionId in SSE, got=${JSON.stringify(buffer)}`);

    const postRes = await fetch(`${baseUrl}/message?sessionId=${sessionId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(postRes.status, 202);

    buffer = await readUntil(reader, buffer, (txt) => txt.includes("event: message\n"), {
      timeoutMs: 3000,
    });

    assert.match(buffer, /event: message/);
    assert.match(buffer, /\"ok\":true/);

    // 主动结束 SSE 连接，避免 server.close 永远等待活跃连接而导致测试挂住。
    controller.abort();
    await reader.cancel().catch(() => {});
  }
);

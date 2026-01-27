import assert from "node:assert/strict";
import test from "node:test";

import { createMcpRequestHandler, resolveAgentSocketPath } from "../src/mcp-core.mjs";

function withEnv(nextEnv, fn) {
  const previous = {};
  for (const key of Object.keys(nextEnv)) {
    previous[key] = process.env[key];
    process.env[key] = nextEnv[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(nextEnv)) {
        if (previous[key] == null) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    });
}

test("mcp-core: resolveAgentSocketPath respects RECAPSENSE_AGENT_SOCKET", async () => {
  await withEnv(
    {
      RECAPSENSE_DATA_DIR: "/tmp/recapsense-mcp-core-test",
      RECAPSENSE_AGENT_SOCKET: "1",
    },
    async () => {
      const socketPath = resolveAgentSocketPath();
      assert.ok(socketPath.endsWith("/run/agent.sock"));
      assert.ok(socketPath.includes("/tmp/recapsense-mcp-core-test"));
    }
  );
});

test("mcp handler: invalid requests, initialize, ping, tools/list", async () => {
  const handler = createMcpRequestHandler({
    agentUrl: "http://agent.local",
    token: "t",
    socketPath: null,
  });

  {
    const res = await handler(null);
    assert.equal(res.error.code, -32600);
  }

  {
    const res = await handler({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    assert.equal(res.result.serverInfo.name, "recapsense");
    assert.equal(res.result.protocolVersion, "2024-11-05");
  }

  {
    const res = await handler({ jsonrpc: "2.0", id: 2, method: "ping" });
    assert.deepEqual(res.result, {});
  }

  {
    const res = await handler({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    assert.ok(Array.isArray(res.result.tools));
    assert.ok(res.result.tools.some((t) => t.name === "recapsense_search"));
  }
});

test("mcp handler: tools/call uses HTTP fetch path (success + error)", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    calls.push({ pathname: u.pathname, search: u.search, method: init?.method });

    if (u.pathname === "/v1/search") {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async json() {
          return {
            results: [
              { id: "c1", start_ts: Date.now(), app: "Chrome", window_title: "Example", snippet: "hi" },
            ],
          };
        },
      };
    }

    if (u.pathname.startsWith("/v1/chunks/")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async json() {
          return { chunk: { id: "c1", start_ts: 1, end_ts: 2, app: "Chrome", window_title: "Example", text: "hello" } };
        },
      };
    }

    if (u.pathname === "/v1/summaries/daily") {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async json() {
          return { summary: null };
        },
      };
    }

    if (u.pathname === "/v1/timeline/daily") {
      return {
        ok: false,
        status: 500,
        statusText: "Oops",
        async text() {
          return "boom";
        },
      };
    }

    throw new Error(`unexpected fetch url: ${u.pathname}`);
  };

  try {
    const handler = createMcpRequestHandler({
      agentUrl: "http://agent.local",
      token: "t",
      socketPath: null,
    });

    // search
    {
      const res = await handler({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "recapsense_search", arguments: { query: "hi", limit: 5 } },
      });
      assert.equal(res.result.content[0].type, "text");
      assert.match(res.result.content[0].text, /id: c1/);
    }

    // get_chunk
    {
      const res = await handler({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "recapsense_get_chunk", arguments: { id: "c1" } },
      });
      assert.match(res.result.content[0].text, /id: c1/);
      assert.match(res.result.content[0].text, /hello/);
    }

    // get_daily_summary (null)
    {
      const res = await handler({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "recapsense_get_daily_summary", arguments: { date: "2026-01-26" } },
      });
      assert.match(res.result.content[0].text, /暂无日总结/);
    }

    // get_daily_timeline -> agent 500 -> isError true
    {
      const res = await handler({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "recapsense_get_daily_timeline", arguments: { date: "2026-01-26" } },
      });
      assert.equal(res.result.isError, true);
      assert.match(res.result.content[0].text, /Agent request failed: 500/);
      assert.match(res.result.content[0].text, /boom/);
    }

    assert.ok(calls.some((c) => c.pathname === "/v1/search"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mcp handler: tools/call unknown tool and notifications are ignored", async () => {
  const handler = createMcpRequestHandler({
    agentUrl: "http://agent.local",
    token: "t",
    socketPath: null,
  });

  {
    const res = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "not-exist", arguments: {} },
    });
    assert.equal(res.error.code, -32601);
  }

  {
    const res = await handler({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(res, null);
  }
});

test("mcp handler: socketPath branch returns isError when socket missing", async () => {
  const handler = createMcpRequestHandler({
    agentUrl: "http://agent.local",
    token: "t",
    socketPath: "/tmp/recapsense-not-exist.sock",
  });

  const res = await handler({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "recapsense_search", arguments: { query: "hi", limit: 5 } },
  });

  assert.equal(res.result.isError, true);
  assert.ok(String(res.result.content?.[0]?.text ?? "").length > 0);
});

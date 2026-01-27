import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  createMcpRequestHandler,
  formatChunk,
  formatDailySummary,
  formatSearchResults,
  formatDailyTimeline,
  resolveAgentSocketPath,
} from "../src/mcp-core.mjs";

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
        if (previous[key] == null) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
}

function makeHttpRequestStub(resolveResponse) {
  return (options, onResponse) => {
    const req = new EventEmitter();
    req.end = () => {
      queueMicrotask(() => {
        try {
          const resolved = resolveResponse(options);
          if (resolved && resolved.error) {
            req.emit("error", resolved.error);
            return;
          }
          const res = new EventEmitter();
          res.statusCode = resolved?.statusCode ?? 200;
          onResponse(res);
          queueMicrotask(() => {
            const body = resolved?.body ?? "";
            if (body !== "") res.emit("data", Buffer.from(String(body)));
            res.emit("end");
          });
        } catch (error) {
          req.emit("error", error);
        }
      });
    };
    return req;
  };
}

test("mcp-core: formatDailyTimeline covers empty lists and duration formatting", async () => {
  assert.match(
    formatDailyTimeline(null, { date: "2026-01-26" }),
    /暂无时间轴数据/
  );

  const base = {
    date: "2026-01-26",
    start_ts: 0,
    end_ts: 1,
    split_gap_ms: 1,
    session_merge_gap_ms: 1,
    apps: [],
    sessions: [],
    spans: [],
  };

  // overview empty -> （无）
  assert.match(formatDailyTimeline(base, { view: "overview" }), /（无）/);

  // sessions empty -> （无）
  assert.match(formatDailyTimeline(base, { view: "sessions" }), /（无）/);

  // spans empty -> （无）
  assert.match(formatDailyTimeline(base, { view: "spans" }), /（无）/);

  const timeline = {
    ...base,
    apps: [
      { app: "A", active_ms: 59 * 60_000, session_count: 1, span_count: 1, frame_count: 1 },
      { app: "B", active_ms: 60 * 60_000, session_count: 1, span_count: 1, frame_count: 1 },
      { app: "C", active_ms: 3 * 60 * 60_000 + 5 * 60_000, session_count: 1, span_count: 1, frame_count: 1 },
    ],
  };
  const text = formatDailyTimeline(timeline, { view: "overview", limit: 10 });
  assert.match(text, /59分/);
  assert.match(text, /1小时/);
  assert.match(text, /3小时5分/);

  const spansText = formatDailyTimeline(
    {
      ...base,
      spans: [
        {
          start_ts: 0,
          end_ts: 1,
          app: "Chrome",
          window_title_norm: "Docs",
          active_ms: 30_000,
          frame_count: 2,
          chunk_count: 1,
          sample_chunk_id: "c1",
        },
      ],
    },
    { view: "spans", limit: 10 }
  );
  assert.match(spansText, /sample_chunk_id=c1/);
});

test("mcp-core: formatters cover optional fields and empty text branches", async () => {
  // formatSearchResults: non-array
  assert.match(formatSearchResults(null), /没有找到结果/);

  // formatSearchResults: optional snippet/app/title
  const text = formatSearchResults([
    { id: "c1", start_ts: 1, app: "", window_title: "", snippet: "" },
  ]);
  assert.match(text, /UnknownApp/);
  assert.match(text, /id: c1/);

  // formatChunk: unknown timestamps + empty text
  const chunkText = formatChunk({ id: "c1", text: "   " });
  assert.match(chunkText, /unknown/);
  assert.match(chunkText, /（空）/);

  // formatDailySummary: empty summary
  const summaryText = formatDailySummary({ date: "2026-01-26", summary: "  " }, "2026-01-26");
  assert.match(summaryText, /日总结：2026-01-26/);
  assert.match(summaryText, /（空）/);
});

test("mcp-core: formatDailyTimeline covers header/app filter/list truncation branches", async () => {
  const timeline = {
    date: "2026-01-26",
    start_ts: null,
    end_ts: null,
    split_gap_ms: 1,
    session_merge_gap_ms: 1,
    apps: [
      { app: "", active_ms: 0, session_count: 1, span_count: 1, frame_count: 1 },
      { app: "B", active_ms: 10_000, session_count: 1, span_count: 1, frame_count: 1 },
      { app: "C", active_ms: 20_000, session_count: 1, span_count: 1, frame_count: 1 },
    ],
    sessions: [
      { start_ts: null, end_ts: null, app: "Chrome", active_ms: 10_000, span_count: 1, titles: [] },
      { start_ts: 0, end_ts: 1, app: "Chrome", active_ms: 20_000, span_count: 2, titles: ["Docs"] },
      { start_ts: 0, end_ts: 1, app: "Slack", active_ms: 30_000, span_count: 3, titles: ["general"] },
    ],
    spans: [
      { start_ts: 0, end_ts: 1, app: "Chrome", window_title_norm: "", active_ms: 0, frame_count: 1, chunk_count: 0 },
      { start_ts: 0, end_ts: 1, app: "Chrome", window_title_norm: "Docs", active_ms: 10_000, frame_count: 1, chunk_count: 1, sample_chunk_id: "c1" },
    ],
  };

  // unknown view -> overview（且 apps 超过 limit -> “共 N” 分支）
  const overview = formatDailyTimeline(timeline, { view: "unknown", limit: 2 });
  assert.match(overview, /（共 3）/);
  assert.match(overview, /0分/);
  assert.match(overview, /UnknownApp/);

  // sessions：带 app filter + limit=1 -> 截断分支 & titles 有无分支
  const sessions = formatDailyTimeline(timeline, { view: "sessions", app: "Chrome", limit: 1 });
  assert.match(sessions, /过滤：app=Chrome/);
  assert.match(sessions, /展示 1/);
  assert.match(sessions, /spans=1/);

  const sessionsWithTitles = formatDailyTimeline(timeline, { view: "sessions", app: "Chrome", limit: 2 });
  assert.match(sessionsWithTitles, /titles:/);

  // spans：app filter 为空时走全量；sample_chunk_id 有无分支
  const spans = formatDailyTimeline(timeline, { view: "spans", limit: 10 });
  assert.match(spans, /chunks=0/);
  assert.match(spans, /sample_chunk_id=c1/);
});

test("mcp-core: resolveAgentSocketPath supports env values", async () => {
  await withEnv(
    {
      RECAPSENSE_DATA_DIR: "/tmp/recapsense-mcp-core-branches",
      RECAPSENSE_AGENT_SOCKET: "/tmp/agent.sock",
    },
    async () => {
      assert.equal(resolveAgentSocketPath(), "/tmp/agent.sock");
    }
  );

  await withEnv(
    {
      RECAPSENSE_DATA_DIR: "/tmp/recapsense-mcp-core-branches",
      RECAPSENSE_AGENT_SOCKET: "run/custom.sock",
    },
    async () => {
      const socketPath = resolveAgentSocketPath();
      assert.ok(socketPath.endsWith("/run/custom.sock"));
    }
  );

  await withEnv(
    {
      RECAPSENSE_DATA_DIR: "/tmp/recapsense-mcp-core-branches",
      RECAPSENSE_AGENT_SOCKET: "",
    },
    async () => {
      assert.equal(resolveAgentSocketPath(), null);
    }
  );
});

test("mcp handler: socketPath branch success paths (search/chunk/summary/timeline)", async () => {
  const token = "t";
  const httpRequest = makeHttpRequestStub((options) => {
    const url = String(options.path ?? "");
    if (url.startsWith("/v1/search")) {
      return { statusCode: 200, body: JSON.stringify({ results: [{ id: "c1", start_ts: 1, app: "A", snippet: "hi" }] }) };
    }
    if (url.startsWith("/v1/chunks/")) {
      return { statusCode: 200, body: JSON.stringify({ chunk: { id: "c1", start_ts: 1, end_ts: 2, app: "A", window_title: "", text: "hello" } }) };
    }
    if (url.startsWith("/v1/summaries/daily")) {
      return { statusCode: 200, body: JSON.stringify({ summary: null }) };
    }
    if (url.startsWith("/v1/timeline/daily")) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          timeline: {
            date: "2026-01-26",
            start_ts: 0,
            end_ts: 1,
            split_gap_ms: 1,
            session_merge_gap_ms: 1,
            apps: [],
            sessions: [],
            spans: [],
          },
        }),
      };
    }
    throw new Error(`unexpected socket path: ${url}`);
  });

  const handler = createMcpRequestHandler({
    agentUrl: "http://agent.local",
    token,
    socketPath: "/tmp/fake.sock",
    httpRequest,
    fetchFn: async () => {
      throw new Error("fetch should not be called");
    },
  });

  // search
  {
    const res = await handler({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recapsense_search", arguments: { query: "hi", limit: 5 } } });
    assert.equal(res.result.isError, undefined);
    assert.match(res.result.content[0].text, /id: c1/);
  }

  // get_chunk
  {
    const res = await handler({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "recapsense_get_chunk", arguments: { id: "c1" } } });
    assert.match(res.result.content[0].text, /hello/);
  }

  // get_daily_summary
  {
    const res = await handler({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "recapsense_get_daily_summary", arguments: { date: "2026-01-26" } } });
    assert.match(res.result.content[0].text, /暂无日总结/);
  }

  // get_daily_timeline
  {
    const res = await handler({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "recapsense_get_daily_timeline", arguments: { date: "2026-01-26", view: "overview" } } });
    assert.match(res.result.content[0].text, /时间轴/);
  }
});

test("mcp handler: socket errors (non-2xx + invalid JSON)", async () => {
  const handlerNon2xx = createMcpRequestHandler({
    agentUrl: "http://agent.local",
    token: "t",
    socketPath: "/tmp/fake.sock",
    httpRequest: makeHttpRequestStub(() => ({ statusCode: 500, body: "boom" })),
    fetchFn: async () => { throw new Error("fetch should not be called"); },
  });
  {
    const res = await handlerNon2xx({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recapsense_search", arguments: { query: "x", limit: 5 } } });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /Agent socket request failed: 500/);
    assert.match(res.result.content[0].text, /boom/);
  }

  const handlerBadJson = createMcpRequestHandler({
    agentUrl: "http://agent.local",
    token: "t",
    socketPath: "/tmp/fake.sock",
    httpRequest: makeHttpRequestStub(() => ({ statusCode: 200, body: "not-json" })),
    fetchFn: async () => { throw new Error("fetch should not be called"); },
  });
  {
    const res = await handlerBadJson({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "recapsense_search", arguments: { query: "x", limit: 5 } } });
    assert.equal(res.result.isError, true);
    assert.ok(String(res.result.content?.[0]?.text ?? "").length > 0);
  }

  const handlerNoStatus = createMcpRequestHandler({
    agentUrl: "http://agent.local",
    token: "t",
    socketPath: "/tmp/fake.sock",
    httpRequest: (_options, onResponse) => {
      const req = new EventEmitter();
      req.end = () => {
        const res = new EventEmitter();
        // 不设置 statusCode -> 走 ?? 0 分支
        onResponse(res);
        queueMicrotask(() => res.emit("end"));
      };
      return req;
    },
    fetchFn: async () => { throw new Error("fetch should not be called"); },
  });
  {
    const res = await handlerNoStatus({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "recapsense_search", arguments: { query: "x", limit: 5 } } });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /Agent socket request failed: 0/);
  }
});

test("mcp handler: HTTP fetch error branch for search", async () => {
  const handler = createMcpRequestHandler({
    agentUrl: "http://agent.local",
    token: "t",
    socketPath: null,
    fetchFn: async (url) => {
      const u = new URL(String(url));
      if (u.pathname === "/v1/search") {
        return {
          ok: false,
          status: 400,
          statusText: "Bad",
          async text() {
            return "oops";
          },
        };
      }
      throw new Error(`unexpected fetch url: ${u.pathname}`);
    },
  });

  const res = await handler({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "recapsense_search", arguments: { query: "x", limit: 5 } },
  });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /Agent request failed: 400/);
});

test("mcp handler: HTTP search passes optional app/scope params and normalizes limit", async () => {
  const calls = [];
  const handler = createMcpRequestHandler({
    agentUrl: "http://agent.local",
    token: "t",
    socketPath: null,
    fetchFn: async (url) => {
      const u = new URL(String(url));
      calls.push(u);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async json() {
          return { results: [] };
        },
      };
    },
  });

  // limit 非 number -> 回退到 10；app/scope 为空字符串 -> 不应写入 query params
  await handler({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "recapsense_search", arguments: { query: "hi", limit: "5", app: " ", scope: " " } },
  });

  // app/scope 非空 -> 写入 params
  await handler({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "recapsense_search", arguments: { query: "hi", limit: 5, app: "Chrome", scope: "meta" } },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].searchParams.get("limit"), "10");
  assert.equal(calls[0].searchParams.get("app"), null);
  assert.equal(calls[0].searchParams.get("scope"), null);
  assert.equal(calls[1].searchParams.get("limit"), "5");
  assert.equal(calls[1].searchParams.get("app"), "Chrome");
  assert.equal(calls[1].searchParams.get("scope"), "meta");
});

test("mcp handler: HTTP fetch error branches for chunk/summary", async () => {
  const handler = createMcpRequestHandler({
    agentUrl: "http://agent.local",
    token: "t",
    socketPath: null,
    fetchFn: async (url) => {
      const u = new URL(String(url));
      if (u.pathname.startsWith("/v1/chunks/")) {
        return {
          ok: false,
          status: 404,
          statusText: "Not Found",
          async text() {
            return "missing";
          },
        };
      }
      if (u.pathname === "/v1/summaries/daily") {
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
    },
  });

  {
    const res = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "recapsense_get_chunk", arguments: { id: "c1" } },
    });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /Agent request failed: 404/);
  }

  {
    const res = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "recapsense_get_daily_summary", arguments: { date: "2026-01-26" } },
    });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /Agent request failed: 500/);
  }
});

test("mcp handler: HTTP error text() failures are swallowed", async () => {
  const handler = createMcpRequestHandler({
    agentUrl: "http://agent.local",
    token: "t",
    socketPath: null,
    fetchFn: async (url) => {
      const u = new URL(String(url));
      if (u.pathname === "/v1/search") {
        return {
          ok: false,
          status: 500,
          statusText: "Oops",
          async text() {
            throw new Error("text boom");
          },
        };
      }
      throw new Error(`unexpected fetch url: ${u.pathname}`);
    },
  });

  const res = await handler({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "recapsense_search", arguments: { query: "x", limit: 5 } },
  });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /Agent request failed: 500/);
});

test("mcp handler: HTTP timeline success path", async () => {
  const handler = createMcpRequestHandler({
    agentUrl: "http://agent.local",
    token: "t",
    socketPath: null,
    fetchFn: async (url) => {
      const u = new URL(String(url));
      if (u.pathname === "/v1/timeline/daily") {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          async json() {
            return {
              timeline: {
                date: "2026-01-26",
                start_ts: 0,
                end_ts: 1,
                split_gap_ms: 1,
                session_merge_gap_ms: 1,
                apps: [],
                sessions: [],
                spans: [],
              },
            };
          },
        };
      }
      throw new Error(`unexpected fetch url: ${u.pathname}`);
    },
  });

  const res = await handler({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "recapsense_get_daily_timeline", arguments: { date: "2026-01-26", view: "overview" } },
  });
  assert.equal(res.result.isError, undefined);
  assert.match(res.result.content[0].text, /时间轴/);
});

test("mcp handler: socket non-2xx branches for chunk/summary/timeline", async () => {
  const handler = createMcpRequestHandler({
    agentUrl: "http://agent.local",
    token: "t",
    socketPath: "/tmp/fake.sock",
    httpRequest: makeHttpRequestStub(() => ({ statusCode: 500, body: "boom" })),
    fetchFn: async () => { throw new Error("fetch should not be called"); },
  });

  {
    const res = await handler({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recapsense_get_chunk", arguments: { id: "c1" } } });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /Agent socket request failed: 500/);
  }

  {
    const res = await handler({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "recapsense_get_daily_summary", arguments: { date: "2026-01-26" } } });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /Agent socket request failed: 500/);
  }

  {
    const res = await handler({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "recapsense_get_daily_timeline", arguments: { date: "2026-01-26" } } });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /Agent socket request failed: 500/);
  }
});

test("mcp handler: socket request errors are propagated", async () => {
  const handler = createMcpRequestHandler({
    agentUrl: "http://agent.local",
    token: "t",
    socketPath: "/tmp/fake.sock",
    httpRequest: () => {
      const req = new EventEmitter();
      req.end = () => {
        queueMicrotask(() => req.emit("error", new Error("socket boom")));
      };
      return req;
    },
    fetchFn: async () => { throw new Error("fetch should not be called"); },
  });

  const res = await handler({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "recapsense_search", arguments: { query: "x", limit: 5 } },
  });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /socket boom/);
});

test("mcp handler: tools/call validates required arguments", async () => {
  const handler = createMcpRequestHandler({ agentUrl: "http://agent.local", token: "t", socketPath: null, fetchFn: async () => ({ ok: true, async json() { return {}; } }) });

  {
    const res = await handler({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recapsense_get_chunk", arguments: { id: "" } } });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /chunk id is required/);
  }

  {
    const res = await handler({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "recapsense_get_daily_summary", arguments: { date: "" } } });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /date is required/);
  }

  {
    const res = await handler({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "recapsense_get_daily_timeline", arguments: { date: "" } } });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /date is required/);
  }
});

test("mcp handler: method not found returns jsonrpc error", async () => {
  const handler = createMcpRequestHandler({
    agentUrl: "http://agent.local",
    token: "t",
    socketPath: null,
    fetchFn: async () => ({ ok: true, async json() { return {}; } }),
  });

  const res = await handler({ jsonrpc: "2.0", id: 1, method: "nope" });
  assert.equal(res.error.code, -32601);
});

test("mcp handler: notifications/initialized request with id is ignored", async () => {
  const handler = createMcpRequestHandler({
    agentUrl: "http://agent.local",
    token: "t",
    socketPath: null,
    fetchFn: async () => ({ ok: true, async json() { return {}; } }),
  });

  const res = await handler({ jsonrpc: "2.0", id: 1, method: "notifications/initialized" });
  assert.equal(res, null);
});

test("mcp handler: initialize defaults protocolVersion to unknown", async () => {
  const handler = createMcpRequestHandler({
    agentUrl: "http://agent.local",
    token: "t",
    socketPath: null,
    fetchFn: async () => ({ ok: true, async json() { return {}; } }),
  });

  const res = await handler({ jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal(res.result.protocolVersion, "unknown");
});

test("mcp handler: socket success with missing fields falls back to defaults", async () => {
  const handler = createMcpRequestHandler({
    agentUrl: "http://agent.local",
    token: "t",
    socketPath: "/tmp/fake.sock",
    httpRequest: makeHttpRequestStub(() => ({ statusCode: 200, body: "{}" })),
    fetchFn: async () => { throw new Error("fetch should not be called"); },
  });

  {
    const res = await handler({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recapsense_search", arguments: { query: "x", limit: 5 } } });
    assert.match(res.result.content[0].text, /没有找到结果/);
  }

  {
    const res = await handler({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "recapsense_get_chunk", arguments: { id: "c1" } } });
    assert.match(res.result.content[0].text, /未找到该 chunk/);
  }

  {
    const res = await handler({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "recapsense_get_daily_timeline", arguments: { date: "2026-01-26" } } });
    assert.match(res.result.content[0].text, /暂无时间轴数据/);
  }
});

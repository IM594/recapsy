import http from "node:http";
import path from "node:path";

import { resolveDataDir } from "./paths.mjs";

export const SERVER_NAME = "recapsense";
export const SERVER_VERSION = "0.0.3";

function jsonRpcError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

function jsonRpcResult(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

export function toolList() {
  return [
    {
      name: "recapsense_search",
      description:
        "在本机 RecapSense 记忆（chunks）中搜索。适合按关键词找回过去的内容；query 为空时返回最近的 chunks（可选按 app 与 scope 过滤）。",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "搜索关键词（FTS）。空字符串表示返回最近 chunks。",
          },
          app: {
            type: "string",
            description: "（可选）只返回 app 匹配的 chunks（大小写不敏感，按值精确匹配）。",
          },
          scope: {
            type: "string",
            enum: ["all", "meta", "text"],
            description:
              "（可选）搜索范围：all=正文+标题+app（默认）；meta=只匹配 app/窗口标题；text=只匹配正文。",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 10,
            description: "返回结果数量上限。",
          },
        },
      },
      annotations: {
        title: "RecapSense 搜索",
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "recapsense_get_chunk",
      description: "按 chunk id 获取完整内容（包含 app/window/title 与全文文本）。",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "chunk id（通常来自 recapsense_search 的结果）。",
          },
        },
        required: ["id"],
      },
      annotations: {
        title: "RecapSense 获取 Chunk",
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "recapsense_get_daily_summary",
      description: "按日期获取日总结；如果当天没有数据会返回空。",
      inputSchema: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "日期（YYYY-MM-DD，例如 2026-01-26）。",
          },
        },
        required: ["date"],
      },
      annotations: {
        title: "RecapSense 获取日总结",
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "recapsense_get_daily_timeline",
      description:
        "按日期获取当天时间轴（app 用时榜 + 会话 sessions + 片段 spans）。适合做日报/周报/复盘的结构化输入。",
      inputSchema: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "日期（YYYY-MM-DD，例如 2026-01-26）。",
          },
          view: {
            type: "string",
            enum: ["overview", "sessions", "spans", "raw"],
            description:
              "输出视图：overview=概览（默认）；sessions=按 app 合并的会话；spans=更细粒度片段；raw=原始 JSON。",
          },
          app: {
            type: "string",
            description: "（可选）只输出该 app 的 sessions/spans（overview 仍会给出全局 app 榜）。",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            default: 50,
            description: "sessions/spans/overview 列表的最大条数。",
          },
        },
        required: ["date"],
      },
      annotations: {
        title: "RecapSense 获取时间轴",
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
  ];
}

export function formatSearchResults(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return "没有找到结果。";
  }

  const lines = [];
  for (let index = 0; index < results.length; index += 1) {
    const item = results[index];
    const start = new Date(Number(item.start_ts)).toISOString();
    const app = item.app ? `${item.app}` : "UnknownApp";
    const title = item.window_title ? ` — ${item.window_title}` : "";
    const snippet = item.snippet ?? "";

    lines.push(`${index + 1}. ${start} | ${app}${title}`);
    if (snippet) lines.push(`   ${String(snippet).replace(/\s+/g, " ").trim()}`);
    lines.push(`   id: ${item.id}`);
  }

  return lines.join("\n");
}

export function formatChunk(chunk) {
  if (!chunk) return "未找到该 chunk。";

  const start = chunk.start_ts != null ? new Date(Number(chunk.start_ts)).toISOString() : "unknown";
  const end = chunk.end_ts != null ? new Date(Number(chunk.end_ts)).toISOString() : "unknown";
  const app = chunk.app ? `${chunk.app}` : "UnknownApp";
  const title = chunk.window_title ? ` — ${chunk.window_title}` : "";
  const text = String(chunk.text ?? "").trim();

  const lines = [];
  lines.push(`${start} ~ ${end} | ${app}${title}`);
  lines.push(`id: ${chunk.id}`);
  lines.push("");
  lines.push(text || "（空）");
  return lines.join("\n");
}

export function formatDailySummary(summary, date) {
  if (!summary) {
    return `日期 ${date ?? ""} 暂无日总结。`;
  }

  const start = summary.start_ts != null ? new Date(Number(summary.start_ts)).toISOString() : "unknown";
  const end = summary.end_ts != null ? new Date(Number(summary.end_ts)).toISOString() : "unknown";
  const text = String(summary.summary ?? "").trim();
  const dateStr = summary.date ?? date ?? "";

  const lines = [];
  lines.push(`日总结：${dateStr}`);
  lines.push(`${start} ~ ${end}`);
  lines.push("");
  lines.push(text || "（空）");
  return lines.join("\n");
}

const DEFAULT_TIME_ZONE = "Asia/Shanghai";

const shanghaiDateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: DEFAULT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const shanghaiTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: DEFAULT_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatShanghaiDateTime(ms) {
  const parts = shanghaiDateTimeFormatter.formatToParts(new Date(Number(ms)));
  const out = {};
  for (const part of parts) {
    if (part.type !== "literal") out[part.type] = part.value;
  }
  return `${out.year}-${out.month}-${out.day} ${out.hour}:${out.minute}:${out.second}`;
}

function formatShanghaiTime(ms) {
  const parts = shanghaiTimeFormatter.formatToParts(new Date(Number(ms)));
  const out = {};
  for (const part of parts) {
    if (part.type !== "literal") out[part.type] = part.value;
  }
  return `${out.hour}:${out.minute}:${out.second}`;
}

function formatDurationMs(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "0分";

  const totalSeconds = Math.floor(value / 1000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours <= 0) return `${minutes}分`;
  if (minutes <= 0) return `${hours}小时`;
  return `${hours}小时${minutes}分`;
}

function normalizeTimelineView(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "sessions") return "sessions";
  if (raw === "spans") return "spans";
  if (raw === "raw") return "raw";
  return "overview";
}

function normalizeListLimit(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(200, Math.floor(n)));
}

export function formatDailyTimeline(timeline, { date, view, limit, app } = {}) {
  if (!timeline) {
    return `日期 ${date ?? ""} 暂无时间轴数据。`;
  }

  const resolvedView = normalizeTimelineView(view);
  const resolvedLimit = normalizeListLimit(limit, 50);
  const appFilter = String(app ?? "").trim();

  if (resolvedView === "raw") {
    return JSON.stringify(timeline, null, 2);
  }

  const header = [];
  header.push(`时间轴：${timeline.date ?? date ?? ""}（${DEFAULT_TIME_ZONE}）`);
  if (timeline.start_ts != null && timeline.end_ts != null) {
    header.push(
      `范围：${formatShanghaiDateTime(timeline.start_ts)} ~ ${formatShanghaiDateTime(timeline.end_ts)}`
    );
  }
  header.push(
    `split_gap_ms=${timeline.split_gap_ms ?? "?"} session_merge_gap_ms=${timeline.session_merge_gap_ms ?? "?"}`
  );
  if (appFilter) header.push(`过滤：app=${appFilter}`);
  header.push("");

  if (resolvedView === "overview") {
    const apps = Array.isArray(timeline.apps) ? timeline.apps : [];
    const top = apps.slice(0, resolvedLimit);

    const lines = [...header];
    lines.push(`App 用时 Top ${top.length}${apps.length > top.length ? `（共 ${apps.length}）` : ""}：`);
    if (top.length === 0) {
      lines.push("（无）");
      return lines.join("\n");
    }

    for (let index = 0; index < top.length; index += 1) {
      const item = top[index];
      const name = item.app ? String(item.app) : "UnknownApp";
      const active = formatDurationMs(item.active_ms);
      const sessions = item.session_count ?? 0;
      const spans = item.span_count ?? 0;
      const frames = item.frame_count ?? 0;
      lines.push(
        `${index + 1}. ${name} — 活跃 ${active} | sessions=${sessions} spans=${spans} frames=${frames}`
      );
    }
    lines.push("");
    lines.push("提示：需要更细粒度的时间线可用 view=sessions 或 view=spans。");
    return lines.join("\n");
  }

  if (resolvedView === "sessions") {
    const sessions = Array.isArray(timeline.sessions) ? timeline.sessions : [];
    const filtered = appFilter
      ? sessions.filter((s) => String(s.app ?? "").trim().toLowerCase() === appFilter.toLowerCase())
      : sessions;
    const list = filtered.slice(0, resolvedLimit);

    const lines = [...header];
    lines.push(
      `会话 sessions：展示 ${list.length}${filtered.length > list.length ? ` / ${filtered.length}` : ""}（按时间升序）`
    );
    if (list.length === 0) {
      lines.push("（无）");
      return lines.join("\n");
    }

    for (const session of list) {
      const start = session.start_ts != null ? formatShanghaiTime(session.start_ts) : "??:??:??";
      const end = session.end_ts != null ? formatShanghaiTime(session.end_ts) : "??:??:??";
      const name = session.app ? String(session.app) : "UnknownApp";
      const active = formatDurationMs(session.active_ms);
      const spanCount = session.span_count ?? 0;
      const titles =
        Array.isArray(session.titles) && session.titles.length > 0
          ? ` | titles: ${session.titles.slice(0, 8).join(" / ")}`
          : "";
      lines.push(`- ${start} ~ ${end}（活跃 ${active}）| ${name} | spans=${spanCount}${titles}`);
    }

    return lines.join("\n");
  }

  // spans
  const spans = Array.isArray(timeline.spans) ? timeline.spans : [];
  const filtered = appFilter
    ? spans.filter((s) => String(s.app ?? "").trim().toLowerCase() === appFilter.toLowerCase())
    : spans;
  const list = filtered.slice(0, resolvedLimit);

  const lines = [...header];
  lines.push(
    `片段 spans：展示 ${list.length}${filtered.length > list.length ? ` / ${filtered.length}` : ""}（按时间升序）`
  );
  if (list.length === 0) {
    lines.push("（无）");
    return lines.join("\n");
  }

  for (const span of list) {
    const start = span.start_ts != null ? formatShanghaiTime(span.start_ts) : "??:??:??";
    const end = span.end_ts != null ? formatShanghaiTime(span.end_ts) : "??:??:??";
    const name = span.app ? String(span.app) : "UnknownApp";
    const title = span.window_title_norm ? String(span.window_title_norm) : "";
    const active = formatDurationMs(span.active_ms);
    const frames = span.frame_count ?? 0;
    const chunks = span.chunk_count ?? 0;
    const sampleChunkId = span.sample_chunk_id ? ` | sample_chunk_id=${span.sample_chunk_id}` : "";
    lines.push(
      `- ${start} ~ ${end}（活跃 ${active}）| ${name}${title ? ` | ${title}` : ""} | frames=${frames} chunks=${chunks}${sampleChunkId}`
    );
  }
  return lines.join("\n");
}

function resolveSocketPathFromDataDir(dataDir) {
  const raw = process.env.RECAPSENSE_AGENT_SOCKET;
  if (!raw || raw.trim() === "") return null;

  const trimmed = raw.trim();
  if (trimmed === "1" || trimmed.toLowerCase() === "true") {
    return path.join(dataDir, "run", "agent.sock");
  }

  if (path.isAbsolute(trimmed)) return trimmed;
  return path.join(dataDir, trimmed);
}

export function resolveAgentSocketPath() {
  const dataDir = resolveDataDir();
  return resolveSocketPathFromDataDir(dataDir);
}

async function callAgentSearchViaHttp({ agentUrl, token, query, limit, app, scope }) {
  const url = new URL("/v1/search", agentUrl);
  url.searchParams.set("q", query ?? "");
  url.searchParams.set("limit", String(limit ?? 10));
  if (app != null && String(app).trim() !== "") url.searchParams.set("app", String(app).trim());
  if (scope != null && String(scope).trim() !== "") url.searchParams.set("scope", String(scope).trim());

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Agent request failed: ${response.status} ${response.statusText}\n${text}`
    );
  }

  const payload = await response.json();
  return payload.results ?? [];
}

async function callAgentSearchViaSocket({ socketPath, token, query, limit, app, scope }) {
  const url = new URL("http://localhost/v1/search");
  url.searchParams.set("q", query ?? "");
  url.searchParams.set("limit", String(limit ?? 10));
  if (app != null && String(app).trim() !== "") url.searchParams.set("app", String(app).trim());
  if (scope != null && String(scope).trim() !== "") url.searchParams.set("scope", String(scope).trim());

  const responseBody = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method: "GET",
        path: url.pathname + url.search,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const body = Buffer.concat(chunks).toString("utf8");
          if (status < 200 || status >= 300) {
            return reject(
              new Error(`Agent socket request failed: ${status}\n${body}`)
            );
          }
          resolve(body);
        });
      }
    );

    req.on("error", reject);
    req.end();
  });

  const payload = JSON.parse(String(responseBody ?? "{}"));
  return payload.results ?? [];
}

function makeCallAgentSearch({ agentUrl, token, socketPath }) {
  if (socketPath) {
    return ({ query, limit, app, scope }) =>
      callAgentSearchViaSocket({ socketPath, token, query, limit, app, scope });
  }
  return ({ query, limit, app, scope }) =>
    callAgentSearchViaHttp({ agentUrl, token, query, limit, app, scope });
}

async function callAgentGetChunkViaHttp({ agentUrl, token, id }) {
  const encodedId = encodeURIComponent(String(id ?? "").trim());
  const url = new URL(`/v1/chunks/${encodedId}`, agentUrl);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Agent request failed: ${response.status} ${response.statusText}\n${text}`
    );
  }

  const payload = await response.json();
  return payload.chunk ?? null;
}

async function callAgentGetChunkViaSocket({ socketPath, token, id }) {
  const encodedId = encodeURIComponent(String(id ?? "").trim());
  const url = new URL(`http://localhost/v1/chunks/${encodedId}`);

  const responseBody = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method: "GET",
        path: url.pathname + url.search,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const body = Buffer.concat(chunks).toString("utf8");
          if (status < 200 || status >= 300) {
            return reject(
              new Error(`Agent socket request failed: ${status}\n${body}`)
            );
          }
          resolve(body);
        });
      }
    );

    req.on("error", reject);
    req.end();
  });

  const payload = JSON.parse(String(responseBody ?? "{}"));
  return payload.chunk ?? null;
}

function makeCallAgentGetChunk({ agentUrl, token, socketPath }) {
  if (socketPath) {
    return ({ id }) => callAgentGetChunkViaSocket({ socketPath, token, id });
  }
  return ({ id }) => callAgentGetChunkViaHttp({ agentUrl, token, id });
}

async function callAgentGetDailySummaryViaHttp({ agentUrl, token, date }) {
  const url = new URL("/v1/summaries/daily", agentUrl);
  url.searchParams.set("date", String(date ?? "").trim());

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Agent request failed: ${response.status} ${response.statusText}\n${text}`
    );
  }

  const payload = await response.json();
  return payload.summary ?? null;
}

async function callAgentGetDailySummaryViaSocket({ socketPath, token, date }) {
  const url = new URL("http://localhost/v1/summaries/daily");
  url.searchParams.set("date", String(date ?? "").trim());

  const responseBody = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method: "GET",
        path: url.pathname + url.search,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const body = Buffer.concat(chunks).toString("utf8");
          if (status < 200 || status >= 300) {
            return reject(
              new Error(`Agent socket request failed: ${status}\n${body}`)
            );
          }
          resolve(body);
        });
      }
    );

    req.on("error", reject);
    req.end();
  });

  const payload = JSON.parse(String(responseBody ?? "{}"));
  return payload.summary ?? null;
}

function makeCallAgentGetDailySummary({ agentUrl, token, socketPath }) {
  if (socketPath) {
    return ({ date }) => callAgentGetDailySummaryViaSocket({ socketPath, token, date });
  }
  return ({ date }) => callAgentGetDailySummaryViaHttp({ agentUrl, token, date });
}

async function callAgentGetDailyTimelineViaHttp({ agentUrl, token, date }) {
  const url = new URL("/v1/timeline/daily", agentUrl);
  url.searchParams.set("date", String(date ?? "").trim());

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Agent request failed: ${response.status} ${response.statusText}\n${text}`
    );
  }

  const payload = await response.json();
  return payload.timeline ?? null;
}

async function callAgentGetDailyTimelineViaSocket({ socketPath, token, date }) {
  const url = new URL("http://localhost/v1/timeline/daily");
  url.searchParams.set("date", String(date ?? "").trim());

  const responseBody = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method: "GET",
        path: url.pathname + url.search,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const body = Buffer.concat(chunks).toString("utf8");
          if (status < 200 || status >= 300) {
            return reject(
              new Error(`Agent socket request failed: ${status}\n${body}`)
            );
          }
          resolve(body);
        });
      }
    );

    req.on("error", reject);
    req.end();
  });

  const payload = JSON.parse(String(responseBody ?? "{}"));
  return payload.timeline ?? null;
}

function makeCallAgentGetDailyTimeline({ agentUrl, token, socketPath }) {
  if (socketPath) {
    return ({ date }) => callAgentGetDailyTimelineViaSocket({ socketPath, token, date });
  }
  return ({ date }) => callAgentGetDailyTimelineViaHttp({ agentUrl, token, date });
}

export function createMcpRequestHandler({ agentUrl, token, socketPath }) {
  const callAgentSearch = makeCallAgentSearch({ agentUrl, token, socketPath });
  const callAgentGetChunk = makeCallAgentGetChunk({ agentUrl, token, socketPath });
  const callAgentGetDailySummary = makeCallAgentGetDailySummary({ agentUrl, token, socketPath });
  const callAgentGetDailyTimeline = makeCallAgentGetDailyTimeline({ agentUrl, token, socketPath });

  return async function handleRequest(message) {
    if (!message || message.jsonrpc !== "2.0" || !("method" in message)) {
      return jsonRpcError(message?.id ?? null, -32600, "Invalid Request");
    }

    const { id, method } = message;
    if (id == null) {
      // notification（无 id）直接忽略
      return null;
    }

    if (method === "initialize") {
      const protocolVersion = message.params?.protocolVersion ?? "unknown";
      return jsonRpcResult(id, {
        protocolVersion,
        capabilities: {
          tools: {},
        },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "RecapSense 提供对本机记忆数据的只读访问。可用工具：recapsense_search（检索）、recapsense_get_chunk（读取 chunk 全文）、recapsense_get_daily_summary（日总结）、recapsense_get_daily_timeline（时间轴）。",
      });
    }

    if (method === "ping") {
      return jsonRpcResult(id, {});
    }

    if (method === "tools/list") {
      return jsonRpcResult(id, { tools: toolList() });
    }

    if (method === "tools/call") {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};

      try {
        let text = "";

        if (name === "recapsense_search") {
          const query = String(args.query ?? "");
          const limit = Number.isFinite(args.limit) ? args.limit : 10;
          const app = String(args.app ?? "").trim();
          const scope = String(args.scope ?? "").trim();
          const results = await callAgentSearch({ query, limit, app, scope });
          text = formatSearchResults(results);
        } else if (name === "recapsense_get_chunk") {
          const chunkId = String(args.id ?? "").trim();
          if (!chunkId) throw new Error("chunk id is required");
          const chunk = await callAgentGetChunk({ id: chunkId });
          text = formatChunk(chunk);
        } else if (name === "recapsense_get_daily_summary") {
          const date = String(args.date ?? "").trim();
          if (!date) throw new Error("date is required (YYYY-MM-DD)");
          const summary = await callAgentGetDailySummary({ date });
          text = formatDailySummary(summary, date);
        } else if (name === "recapsense_get_daily_timeline") {
          const date = String(args.date ?? "").trim();
          if (!date) throw new Error("date is required (YYYY-MM-DD)");
          const view = String(args.view ?? "").trim();
          const app = String(args.app ?? "").trim();
          const limit = args.limit;
          const timeline = await callAgentGetDailyTimeline({ date });
          text = formatDailyTimeline(timeline, { date, view, app, limit });
        } else {
          return jsonRpcError(id, -32601, `Unknown tool: ${name}`);
        }

        return jsonRpcResult(id, {
          content: [{ type: "text", text }],
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        return jsonRpcResult(id, {
          isError: true,
          content: [{ type: "text", text: messageText }],
        });
      }
    }

    // 已知的通知类型：忽略即可
    if (method === "notifications/initialized") {
      return null;
    }

    return jsonRpcError(id, -32601, "Method not found");
  };
}

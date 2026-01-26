import http from "node:http";
import path from "node:path";

import { resolveDataDir } from "./paths.mjs";

export const SERVER_NAME = "recapsense";
export const SERVER_VERSION = "0.0.2";

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

export function createMcpRequestHandler({ agentUrl, token, socketPath }) {
  const callAgentSearch = makeCallAgentSearch({ agentUrl, token, socketPath });
  const callAgentGetChunk = makeCallAgentGetChunk({ agentUrl, token, socketPath });
  const callAgentGetDailySummary = makeCallAgentGetDailySummary({ agentUrl, token, socketPath });

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
          "RecapSense 提供对本机记忆数据的只读访问。可用工具：recapsense_search（检索）、recapsense_get_chunk（读取 chunk 全文）、recapsense_get_daily_summary（日总结）。",
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

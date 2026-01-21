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
        "在本机 RecapSense 记忆（chunks）中搜索。适合按关键词找回过去的内容；query 为空时返回最近的 chunks。",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "搜索关键词（FTS）。空字符串表示返回最近 chunks。",
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

async function callAgentSearchViaHttp({ agentUrl, token, query, limit }) {
  const url = new URL("/v1/search", agentUrl);
  url.searchParams.set("q", query ?? "");
  url.searchParams.set("limit", String(limit ?? 10));

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

async function callAgentSearchViaSocket({ socketPath, token, query, limit }) {
  const url = new URL("http://localhost/v1/search");
  url.searchParams.set("q", query ?? "");
  url.searchParams.set("limit", String(limit ?? 10));

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
    return ({ query, limit }) =>
      callAgentSearchViaSocket({ socketPath, token, query, limit });
  }
  return ({ query, limit }) => callAgentSearchViaHttp({ agentUrl, token, query, limit });
}

export function createMcpRequestHandler({ agentUrl, token, socketPath }) {
  const callAgentSearch = makeCallAgentSearch({ agentUrl, token, socketPath });

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
          "RecapSense 提供对本机记忆数据的只读访问。使用 recapsense_search 可以按关键词检索相关 chunks（按时间临近排序展示）。",
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

      if (name !== "recapsense_search") {
        return jsonRpcError(id, -32601, `Unknown tool: ${name}`);
      }

      try {
        const query = String(args.query ?? "");
        const limit = Number.isFinite(args.limit) ? args.limit : 10;
        const results = await callAgentSearch({ query, limit });
        const text = formatSearchResults(results);
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


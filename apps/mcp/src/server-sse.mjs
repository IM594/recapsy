import crypto from "node:crypto";
import http from "node:http";

import { loadAgentToken } from "./token.mjs";
import { createMcpRequestHandler, resolveAgentSocketPath } from "./mcp-core.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4833;

function formatLocalTimestamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${second}.${ms}`;
}

function installTimestampedConsole() {
  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  const prefix = () => `[${formatLocalTimestamp()}]`;
  console.log = (...args) => original.log(prefix(), ...args);
  console.warn = (...args) => original.warn(prefix(), ...args);
  console.error = (...args) => original.error(prefix(), ...args);
}

function installParentWatchdog(label) {
  const raw = process.env.RECAPSENSE_PARENT_PID;
  if (!raw) return;
  const parentPid = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parentPid) || parentPid <= 1) return;

  const check = () => {
    if (process.ppid === 1) {
      console.warn(`[${label}] parent pid missing (ppid=1), exiting`);
      process.exit(0);
    }

    try {
      process.kill(parentPid, 0);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ESRCH") {
        console.warn(`[${label}] parent pid missing (${parentPid}), exiting`);
        process.exit(0);
      }
    }
  };

  check();
  const timer = setInterval(check, 1000);
  timer.unref();
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function readJson(req, { maxBytes = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        const error = new Error("Request body too large");
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (chunks.length === 0) return resolve(null);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        const error = new Error("Invalid JSON");
        error.statusCode = 400;
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function getTokenFromRequest(req, url) {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }
  const fromQuery = url.searchParams.get("token");
  if (fromQuery && fromQuery.trim() !== "") {
    return fromQuery.trim();
  }
  return null;
}

function sendSseHeaders(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  // 立即 flush 一段内容，避免某些代理/中间层缓冲。
  res.write(": connected\n\n");
}

function writeSseEvent(res, { event, data }) {
  if (event) {
    res.write(`event: ${event}\n`);
  }
  const payload =
    typeof data === "string" ? data : JSON.stringify(data ?? null);
  // SSE 允许多行 data，需要逐行前缀。
  for (const line of String(payload).split("\n")) {
    res.write(`data: ${line}\n`);
  }
  res.write("\n");
}

function generateSessionId() {
  // 使用 URL-safe 的随机串，避免在 URL 里出现特殊字符。
  return crypto.randomBytes(18).toString("base64url");
}

async function main() {
  installTimestampedConsole();
  installParentWatchdog("mcp-sse");
  console.log("[mcp-sse] session start");

  const host = process.env.RECAPSENSE_MCP_HOST ?? DEFAULT_HOST;
  const port = parsePositiveInt(process.env.RECAPSENSE_MCP_PORT, DEFAULT_PORT);

  const agentUrl = process.env.RECAPSENSE_AGENT_URL ?? "http://127.0.0.1:4832";
  const socketPath = resolveAgentSocketPath();
  const token = await loadAgentToken();

  const keepAliveSeconds = parsePositiveInt(
    process.env.RECAPSENSE_MCP_SSE_KEEPALIVE_SECONDS,
    15
  );

  const handleRequest = createMcpRequestHandler({ agentUrl, token, socketPath });

  // sessionId -> { res, keepAliveTimer, createdAt }
  const sessions = new Map();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);

      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === "GET" && url.pathname === "/sse") {
        const provided = getTokenFromRequest(req, url);
        if (provided !== token) {
          return sendJson(res, 401, { error: "Unauthorized" });
        }

        const sessionId = generateSessionId();
        sendSseHeaders(res);

        // MCP SSE 约定：服务端先告诉客户端“发消息”的 endpoint。
        // 我们把 sessionId 放进 query，便于多会话。
        writeSseEvent(res, {
          event: "endpoint",
          data: `/message?sessionId=${sessionId}`,
        });

        const keepAliveTimer = setInterval(() => {
          try {
            res.write(`: keepalive ${Date.now()}\n\n`);
          } catch {
            // 忽略写失败：close 事件会清理。
          }
        }, keepAliveSeconds * 1000);
        keepAliveTimer.unref();

        sessions.set(sessionId, {
          res,
          keepAliveTimer,
          createdAt: Date.now(),
        });

        req.on("close", () => {
          const session = sessions.get(sessionId);
          if (session) {
            clearInterval(session.keepAliveTimer);
          }
          sessions.delete(sessionId);
        });

        return;
      }

      if (req.method === "POST" && url.pathname === "/message") {
        const provided = getTokenFromRequest(req, url);
        if (provided !== token) {
          return sendJson(res, 401, { error: "Unauthorized" });
        }

        const sessionIdFromQuery = url.searchParams.get("sessionId")?.trim();
        let sessionId = sessionIdFromQuery;

        if (!sessionId) {
          // 如果没有带 sessionId，且当前只有一个会话，就默认路由到它（便于调试）。
          if (sessions.size === 1) {
            sessionId = [...sessions.keys()][0];
          }
        }

        if (!sessionId || !sessions.has(sessionId)) {
          return sendJson(res, 404, { error: "Unknown session" });
        }

        const session = sessions.get(sessionId);
        const message = await readJson(req);
        const response = await handleRequest(message);

        // 对于通知（无 id）或被忽略的消息：不通过 SSE 回任何东西，但仍返回 ok。
        if (response && session?.res) {
          writeSseEvent(session.res, { event: "message", data: response });
        }

        return sendJson(res, 202, { ok: true });
      }

      return sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      const statusCode = Number(error?.statusCode ?? 500);
      const message = error instanceof Error ? error.message : String(error);
      return sendJson(res, statusCode, { error: message });
    }
  });

  server.on("error", (error) => {
    console.error("[mcp-sse] server error:", error);
    process.exitCode = 1;
  });

  server.listen(port, host, () => {
    console.log(`[mcp-sse] listening: http://${host}:${port}`);
    console.log(`[mcp-sse] sse endpoint: http://${host}:${port}/sse`);
    console.log(`[mcp-sse] agentUrl: ${agentUrl}`);
    console.log(
      `[mcp-sse] agentSocket: ${socketPath ? socketPath : "(disabled)"}`
    );
    console.log(`[mcp-sse] tokenHint: ****${token.slice(-6)}`);
  });
}

main().catch((error) => {
  console.error("[mcp-sse] fatal:", error);
  process.exitCode = 1;
});

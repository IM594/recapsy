import http from "node:http";

import { loadAgentToken } from "./token.mjs";
import { createMcpRequestHandler, resolveAgentSocketPath } from "./mcp-core.mjs";
import { createSseService } from "./sse-service.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4833;
const SERVICE_NAME = "recapsense-mcp-sse";

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

function logSessionSeparator() {
  const line = "=".repeat(78);
  console.log(`[mcp-sse] ${line}`);
  console.log(`[mcp-sse] 启动分割（pid=${process.pid}）`);
  console.log(`[mcp-sse] argv：${process.argv.join(" ")}`);
  console.log(`[mcp-sse] ${line}`);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

async function main() {
  installTimestampedConsole();
  installParentWatchdog("mcp-sse");
  logSessionSeparator();

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

  const sse = createSseService({
    host,
    token,
    keepAliveSeconds,
    handleRequest,
    onShutdown: () => {
      const timer = setTimeout(() => process.exit(0), 80);
      timer.unref();
    },
  });

  const server = http.createServer(sse.handler);

  // listen 失败（例如 EADDRINUSE）时必须退出，否则会出现“进程还活着但端口没起来”的假象。
  server.once("error", (error) => {
    console.error("[mcp-sse] server listen error:", error);
    process.exit(1);
  });

  server.listen(port, host, () => {
    // listen 成功后，再把 error 降级为“仅记录”（避免把短暂连接错误当成 fatal）。
    server.on("error", (error) => {
      console.error("[mcp-sse] server error:", error);
    });

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

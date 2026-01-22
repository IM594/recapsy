import { stdin, stdout } from "node:process";

import { loadAgentToken } from "./token.mjs";
import { resolveAgentSocketPath, createMcpRequestHandler } from "./mcp-core.mjs";

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

class ReadBuffer {
  #buffer;

  append(chunk) {
    this.#buffer = this.#buffer
      ? Buffer.concat([this.#buffer, chunk])
      : chunk;
  }

  readMessage() {
    if (!this.#buffer) return null;
    const index = this.#buffer.indexOf("\n");
    if (index === -1) return null;
    const line = this.#buffer.toString("utf8", 0, index).replace(/\r$/, "");
    this.#buffer = this.#buffer.subarray(index + 1);
    if (line.trim() === "") return null;
    return JSON.parse(line);
  }
}

function serializeMessage(message) {
  return JSON.stringify(message) + "\n";
}

function writeMessage(message) {
  stdout.write(serializeMessage(message));
}

async function main() {
  installTimestampedConsole();
  installParentWatchdog("mcp");
  console.log("[mcp] session start");

  const agentUrl = process.env.RECAPSENSE_AGENT_URL ?? "http://127.0.0.1:4832";
  const socketPath = resolveAgentSocketPath();
  const token = await loadAgentToken();
  const handleRequest = createMcpRequestHandler({ agentUrl, token, socketPath });

  const buffer = new ReadBuffer();
  stdin.on("data", async (chunk) => {
    try {
      buffer.append(chunk);
      // 读取并处理所有完整的 JSON-RPC 消息（以换行分隔）
      while (true) {
        const msg = buffer.readMessage();
        if (!msg) break;
        const response = await handleRequest(msg);
        if (response) writeMessage(response);
      }
    } catch (error) {
      const id = null;
      const messageText = error instanceof Error ? error.message : String(error);
      writeMessage({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: messageText },
      });
    }
  });

  stdin.resume();
}

main().catch((error) => {
  console.error("[mcp] fatal:", error);
  process.exitCode = 1;
});

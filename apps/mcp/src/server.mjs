import { stdin, stdout } from "node:process";

import { loadAgentToken } from "./token.mjs";
import { resolveAgentSocketPath, createMcpRequestHandler } from "./mcp-core.mjs";

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

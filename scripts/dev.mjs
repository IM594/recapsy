import { spawn } from "node:child_process";
import process from "node:process";

function log(message) {
  process.stdout.write(`[dev] ${message}\n`);
}

function spawnProcess(name, command, args, options) {
  const child = spawn(command, args, {
    stdio: "inherit",
    ...options,
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      log(`${name} 退出（signal=${signal}）`);
      return;
    }
    if (code === 0) {
      log(`${name} 正常退出`);
      return;
    }
    log(`${name} 异常退出（code=${code}）`);
  });

  child.on("error", (error) => {
    log(`${name} 启动失败：${String(error)}`);
  });

  return child;
}

async function main() {
  // 目标：让开发体验更“傻瓜”：
  // 一条命令启动 Agent + MCP(SSE)，并默认开启 UDS（不影响 collector 的 HTTP）。
  const env = {
    ...process.env,
    RECAPSENSE_AGENT_SOCKET: process.env.RECAPSENSE_AGENT_SOCKET ?? "1",
  };

  log("启动 Agent（HTTP + UDS）…");
  const agent = spawnProcess(
    "agent",
    "node",
    ["apps/agent/src/server.mjs"],
    { env }
  );

  log("启动 MCP（SSE）…");
  const mcp = spawnProcess("mcp-sse", "node", ["apps/mcp/src/server-sse.mjs"], {
    env,
  });

  const children = [agent, mcp];

  const shutdown = (signal) => {
    log(`收到 ${signal}，准备退出…`);
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        // 忽略
      }
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  log(`fatal: ${String(error)}`);
  process.exitCode = 1;
});


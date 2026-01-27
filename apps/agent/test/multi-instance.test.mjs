import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { canListenTcp, getAvailablePort } from "../test-utils/tcp.mjs";

const canListen = await canListenTcp();

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recapsense-agent-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function startOccupyingServer({ host, port }) {
  const server = http.createServer((req, res) => {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("occupied");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

function waitForExit(child, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    if (child.exitCode != null) {
      resolve({ code: child.exitCode, signal: null });
      return;
    }
    if (child.signalCode != null) {
      resolve({ code: null, signal: child.signalCode });
      return;
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timeout waiting for child exit"));
    }, timeoutMs);

    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test(
  "TEST-2: 端口被占用时不会 unlink 掉 agent.sock（避免破坏 UDS）",
  { skip: canListen ? false : "当前环境不允许 net.listen，跳过真实端口回归" },
  async () => {
    await withTempDir(async (dataDir) => {
      const host = "127.0.0.1";
      const port = await getAvailablePort({ host });
      const occupyingServer = await startOccupyingServer({ host, port });

      const socketPath = path.join(dataDir, "run", "agent.sock");
      await fs.mkdir(path.dirname(socketPath), { recursive: true });
      await fs.writeFile(socketPath, "SENTINEL\n", "utf8");

      const scriptPath = fileURLToPath(new URL("../src/server.mjs", import.meta.url));

      const child = spawn(process.execPath, [scriptPath], {
        env: {
          ...process.env,
          RECAPSENSE_DATA_DIR: dataDir,
          RECAPSENSE_AGENT_HOST: host,
          RECAPSENSE_AGENT_PORT: String(port),
          RECAPSENSE_AGENT_SOCKET: "1",
        },
        stdio: "ignore",
      });

      const exited = await waitForExit(child);
      assert.equal(exited.signal, null);
      assert.equal(exited.code, 1);

      const content = await fs.readFile(socketPath, "utf8");
      assert.equal(content, "SENTINEL\n");

      await new Promise((resolve) => occupyingServer.close(resolve));
    });
  }
);

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { canListenTcp, getAvailablePort, waitForHttpOk } from "../test-utils/tcp.mjs";

const canListen = await canListenTcp();

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recapsense-agent-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function readTextWithRetry(filePath, { timeoutMs = 3000, intervalMs = 80 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const trimmed = content.trim();
      if (trimmed) return trimmed;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting for file: ${filePath}`);
}

function waitForExit(child, { timeoutMs = 8000 } = {}) {
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
  "TEST-1b: Agent 真实端口 E2E（health + token + ingest/search + shutdown）",
  { skip: canListen ? false : "当前环境不允许 net.listen，跳过真实端口 E2E" },
  async (t) => {
    await withTempDir(async (dataDir) => {
      const host = "127.0.0.1";
      const port = await getAvailablePort({ host });
      const baseUrl = `http://${host}:${port}`;

      const scriptPath = fileURLToPath(new URL("../src/server.mjs", import.meta.url));

      const child = spawn(process.execPath, [scriptPath], {
        env: {
          ...process.env,
          RECAPSENSE_DATA_DIR: dataDir,
          RECAPSENSE_AGENT_HOST: host,
          RECAPSENSE_AGENT_PORT: String(port),
          // E2E 专注 TCP 路径：不启用 UDS，避免与其他测试互相影响。
          RECAPSENSE_AGENT_SOCKET: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let logs = "";
      child.stdout.on("data", (chunk) => {
        logs += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        logs += chunk.toString("utf8");
      });

      const cleanup = async () => {
        if (child.exitCode != null || child.signalCode != null) return;
        child.kill("SIGTERM");
        await waitForExit(child).catch(() => {});
      };
      t.after(cleanup);

      await waitForHttpOk(`${baseUrl}/health`, { timeoutMs: 5000 });

      const token = await readTextWithRetry(path.join(dataDir, "secret", "token"), {
        timeoutMs: 5000,
      });

      const healthRes = await fetch(`${baseUrl}/health`);
      assert.equal(healthRes.status, 200);

      const noAuthRes = await fetch(`${baseUrl}/v1/settings`);
      assert.equal(noAuthRes.status, 401);

      const settingsRes = await fetch(`${baseUrl}/v1/settings`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(settingsRes.status, 200);
      const settingsBody = await settingsRes.json();
      assert.ok(settingsBody.settings, "settings should exist");

      const patchRes = await fetch(`${baseUrl}/v1/settings`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ agent: { evidenceRetentionDays: 7 } }),
      });
      assert.equal(patchRes.status, 200);

      const now = Date.now();
      const chunkId = `test-${now}`;

      const ingestFrameRes = await fetch(`${baseUrl}/v1/ingest/frame`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ts: now,
          app: "TestApp",
          windowTitle: "TestTitle",
          ocrText: "hello world from e2e",
        }),
      });
      assert.ok([200, 202].includes(ingestFrameRes.status));

      const upsertChunkRes = await fetch(`${baseUrl}/v1/ingest/chunk`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: chunkId,
          startTs: now,
          endTs: now + 1000,
          app: "TestApp",
          windowTitle: "TestTitle",
          text: "hello world from e2e",
        }),
      });
      assert.equal(upsertChunkRes.status, 200);

      const searchRes = await fetch(`${baseUrl}/v1/search?q=hello&limit=10`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(searchRes.status, 200);
      const searchBody = await searchRes.json();
      assert.ok(Array.isArray(searchBody.results));
      assert.ok(searchBody.results.length >= 1, "should return at least one chunk");

      const chunkRes = await fetch(`${baseUrl}/v1/chunks/${chunkId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(chunkRes.status, 200);
      const chunkBody = await chunkRes.json();
      assert.equal(chunkBody.chunk?.id, chunkId);

      const shutdownRes = await fetch(`${baseUrl}/v1/maintenance/shutdown`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(shutdownRes.status, 202);

      const exited = await waitForExit(child);
      assert.equal(exited.signal, null);
      assert.equal(exited.code, 0, logs);
    });
  }
);

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveDataDir } from "./paths.mjs";
import { loadOrCreateApiToken } from "./secrets.mjs";
import { openDatabase } from "./db.mjs";
import { createStore } from "./store.mjs";
import { createAgentRequestHandler } from "./agent-handler.mjs";
import { createEvidenceMaintenance } from "./maintenance.mjs";
import { acquireDataDirLock, removeFileIfExists } from "./data-dir-lock.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4832;
const SERVICE_NAME = "recapsense-agent";

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
    // 组合判断，尽量减少 PID 被复用导致误判的概率：
    // - 如果 ppid 变成 1，几乎可以确定父进程已死（被 init/launchd 接管）。
    // - 否则再用 kill(pid, 0) 做一次存在性检测。
    if (process.ppid === 1) {
      console.warn(`[${label}] parent pid missing (ppid=1), exiting`);
      process.exit(0);
    }

    try {
      process.kill(parentPid, 0);
    } catch (error) {
      // ESRCH：进程不存在；EPERM：存在但无权限（视为仍然存在）。
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

function resolveSocketPath(dataDir) {
  const raw = process.env.RECAPSENSE_AGENT_SOCKET;
  if (!raw || raw.trim() === "") return null;

  const trimmed = raw.trim();
  if (trimmed === "1" || trimmed.toLowerCase() === "true") {
    return path.join(dataDir, "run", "agent.sock");
  }

  if (path.isAbsolute(trimmed)) return trimmed;
  return path.join(dataDir, trimmed);
}

async function writeAgentRunInfo({ dataDir, host, port, disableTcp, socketPath, tcpOk, socketOk }) {
  const filePath = path.join(dataDir, "run", "agent.json");
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const tcpUrl = tcpOk && !disableTcp ? `http://${host}:${port}` : null;

  const payload = {
    service: SERVICE_NAME,
    pid: process.pid,
    dataDir,
    startedAt: new Date().toISOString(),
    listeners: {
      tcp: tcpOk && !disableTcp ? { host, port, url: tcpUrl } : null,
      socket: socketOk && socketPath ? { path: socketPath } : null,
    },
  };

  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

function logSessionSeparator() {
  const line = "=".repeat(78);
  console.log(`[agent] ${line}`);
  console.log(`[agent] 启动分割（pid=${process.pid}）`);
  console.log(`[agent] argv：${process.argv.join(" ")}`);
  console.log(`[agent] ${line}`);
}

function parseJsonSafe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function probeAgentHealthOverTcp({ host, port, timeoutMs = 250 } = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, path: "/health", method: "GET" },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
          const body = Buffer.concat(chunks).toString("utf8");
          const json = parseJsonSafe(body);
          const service = json && typeof json === "object" ? json.service : null;
          resolve(service);
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(null);
    });

    req.on("error", () => resolve(null));
    req.end();
  });
}

function probeAgentHealthOverSocket({ socketPath, timeoutMs = 250 } = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { socketPath, path: "/health", method: "GET" },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
          const body = Buffer.concat(chunks).toString("utf8");
          const json = parseJsonSafe(body);
          const service = json && typeof json === "object" ? json.service : null;
          resolve(service);
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(null);
    });

    req.on("error", () => resolve(null));
    req.end();
  });
}

async function detectExistingAgent({
  host,
  port,
  socketPath,
  disableTcp,
} = {}) {
  if (!disableTcp) {
    const service = await probeAgentHealthOverTcp({ host, port });
    if (service === SERVICE_NAME) return { via: "tcp" };
  }

  if (socketPath) {
    const service = await probeAgentHealthOverSocket({ socketPath });
    if (service === SERVICE_NAME) return { via: "socket" };
  }

  return null;
}

async function main() {
  installTimestampedConsole();
  installParentWatchdog("agent");
  logSessionSeparator();

  const dataDir = resolveDataDir();

  const host = process.env.RECAPSENSE_AGENT_HOST ?? DEFAULT_HOST;
  const disableTcp = process.env.RECAPSENSE_AGENT_DISABLE_TCP === "1";
  const port = Number.parseInt(
    process.env.RECAPSENSE_AGENT_PORT ?? String(DEFAULT_PORT),
    10
  );
  const socketPath = resolveSocketPath(dataDir);

  // 单实例锁（按 dataDir）：避免多个 Agent 同时写同一个 SQLite（风险极高）。
  try {
    await acquireDataDirLock({
      dataDir,
      label: "agent",
      serviceName: SERVICE_NAME,
      installProcessHandlers: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // dataDir 已被占用：视为“正常退出”，不标记 fatal。
    if (message.includes("同一数据目录")) {
      console.warn(message);
      return;
    }
    throw error;
  }

  const existing = await detectExistingAgent({
    host,
    port,
    socketPath,
    disableTcp,
  });
  if (existing) {
    console.warn(
      `[agent] 检测到已有 Agent 正在运行（via=${existing.via}），为避免多实例，本进程退出`
    );
    return;
  }

  const token = await loadOrCreateApiToken(dataDir);
  let store = null;
  let dbConn = null;

  const getStore = () => store;
  const getDb = () => dbConn;
  const evidence = createEvidenceMaintenance({ dataDir, getStore });

  // 证据维护任务：从 settings 读取间隔，允许 UI 动态修改后生效（无需重启 Agent）。
  // 注意：按产品策略“只提醒不自动删”，这里仅做 media 占用阈值提醒；清理需要用户手动触发。
  const scheduleEvidenceMaintenance = () => {
    const currentStore = getStore();
    if (!currentStore) return;

    const intervalMinutes = currentStore.getSettings().agent.evidenceCleanupIntervalMinutes;
    const delayMs = Math.max(1, Number(intervalMinutes)) * 60_000;

    const timer = setTimeout(() => {
      evidence.maybeWarnMediaSize()
        .catch((error) => {
          console.warn("[agent] media warn error:", error);
        })
        .finally(() => {
          scheduleEvidenceMaintenance();
        });
    }, delayMs);
    timer.unref();
  };

  console.log(`[agent] dataDir: ${dataDir}`);
  console.log(`[agent] tokenFile: ${dataDir}/secret/token`);
  console.log(`[agent] tokenHint: ****${token.slice(-6)}`);
  const handler = createAgentRequestHandler({
    host,
    serviceName: SERVICE_NAME,
    dataDir,
    token,
    getStore,
    getDb,
    maintenance: evidence,
    onShutdown: () => {
      const timer = setTimeout(() => process.exit(0), 80);
      timer.unref();
    },
  });

  async function listenTcp() {
    if (disableTcp) return false;

    const server = http.createServer(handler);
    return new Promise((resolve) => {
      const onError = (error) => {
        console.error("[agent] tcp listen error:", error);
        resolve(false);
      };

      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        server.on("error", (error) => {
          console.error("[agent] tcp server error:", error);
        });

        console.log(`[agent] listening: http://${host}:${port}`);

        resolve(true);
      });
    });
  }

  async function listenSocket() {
    if (!socketPath) return false;

    await fs.mkdir(path.dirname(socketPath), { recursive: true });
    await removeFileIfExists(socketPath);

    const server = http.createServer(handler);
    return new Promise((resolve) => {
      const onError = (error) => {
        console.error("[agent] socket listen error:", error);
        resolve(false);
      };

      server.once("error", onError);
      server.listen(socketPath, () => {
        server.off("error", onError);
        server.on("error", (error) => {
          console.error("[agent] socket server error:", error);
        });

        console.log(`[agent] listening (unix socket): ${socketPath}`);
        resolve(true);
      });
    });
  }

  // 重要：先启动 TCP，再启动 UDS。
  // 否则在端口被占用（EADDRINUSE）时，第二个实例可能会先 unlink 掉正在使用的 agent.sock，
  // 造成“主 agent 的 unix socket 被破坏”。
  const tcpOk = await listenTcp();
  if (!disableTcp && !tcpOk) {
    throw new Error(`TCP listener failed (host=${host} port=${port})`);
  }

  const socketOk = await listenSocket();
  if (!disableTcp && !tcpOk && !socketOk) {
    throw new Error("No listeners started (tcp + unix socket both failed)");
  }

  if (disableTcp && !socketOk) {
    throw new Error("No listeners started (tcp disabled but unix socket failed)");
  }

  // listeners 已就绪：再打开 DB 与启动后台任务（避免“端口冲突时仍抢占 DB”）。
  const { db, withTransaction } = await openDatabase(dataDir);
  dbConn = db;
  store = createStore(db, { withTransaction });

  // 尽力而为的后台压实任务（frames → chunks），失败不影响主流程。
  const compactionIntervalMs = 30_000;
  const compactionTimer = setInterval(() => {
    try {
      const { createdChunks } = store.compactFramesToChunks();
      if (createdChunks > 0) {
        console.log(`[agent] compacted frames -> ${createdChunks} chunks`);
      }
    } catch (error) {
      console.warn("[agent] compaction error:", error);
    }
  }, compactionIntervalMs);
  compactionTimer.unref();

  // 尽力而为的日总结生成（纯文本 heuristic），失败不影响主流程。
  const dailySummaryIntervalMs = 10 * 60_000;
  const dailySummaryTimer = setInterval(() => {
    try {
      const today = formatLocalDate(new Date());
      const yesterday = formatLocalDate(new Date(Date.now() - 24 * 60 * 60_000));
      store.ensureDailySummary(today);
      store.ensureDailySummary(yesterday);
    } catch (error) {
      console.warn("[agent] daily summary error:", error);
    }
  }, dailySummaryIntervalMs);
  dailySummaryTimer.unref();

  scheduleEvidenceMaintenance();
  await writeAgentRunInfo({ dataDir, host, port, disableTcp, socketPath, tcpOk, socketOk });
}

main().catch((error) => {
  console.error("[agent] fatal:", error);
  process.exit(1);
});

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function log(message) {
  process.stdout.write(`[collector-dev] ${message}\n`);
}

function spawnProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        return reject(new Error(`进程退出（signal=${signal}）`));
      }
      if (code === 0) return resolve();
      reject(new Error(`进程退出（code=${code}）`));
    });
  });
}

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

async function readAgentUrlFromRunInfo(dataDir) {
  const runInfo = path.join(dataDir, "run", "agent.json");
  if (!(await fileExists(runInfo))) return null;
  try {
    const raw = await fs.readFile(runInfo, "utf8");
    const parsed = JSON.parse(raw);
    const url = parsed?.listeners?.tcp?.url;
    if (typeof url === "string" && url.trim() !== "") return url.trim();
  } catch {
    // ignore
  }
  return null;
}

function resolveRepoRoot() {
  // 约定：从仓库根目录执行 `npm run dev:collector`
  return process.cwd();
}

async function main() {
  const repoRoot = resolveRepoRoot();
  const dataDir = process.env.RECAPSENSE_DATA_DIR ?? path.join(repoRoot, ".recapsense");
  const agentUrl =
    process.env.RECAPSENSE_AGENT_URL ??
    (await readAgentUrlFromRunInfo(dataDir)) ??
    "http://127.0.0.1:4832";

  const packagePath = path.join(repoRoot, "apps", "collector-macos");
  const binaryPath = path.join(
    packagePath,
    ".build",
    "release",
    "recapsense-collector"
  );

  const args = process.argv.slice(2);
  const shouldBuild = args.includes("--build") || !(await fileExists(binaryPath));
  const filteredArgs = args.filter((x) => x !== "--build");

  if (shouldBuild) {
    log("编译 macOS collector（swift build -c release）…");
    await spawnProcess("swift", ["build", "-c", "release", "--package-path", packagePath], {
      cwd: repoRoot,
      env: process.env,
    });
  }

  log(`启动 collector（dataDir=${dataDir}）…`);
  await spawnProcess(binaryPath, filteredArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      RECAPSENSE_DATA_DIR: dataDir,
      RECAPSENSE_AGENT_URL: agentUrl,
      // 让 collector 在父进程（本脚本）退出时自动退出，避免残留后台多实例。
      RECAPSENSE_PARENT_PID: String(process.pid),
    },
  });
}

main().catch((error) => {
  log(`fatal: ${String(error)}`);
  process.exitCode = 1;
});

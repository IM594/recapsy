import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function log(message) {
  process.stdout.write(`[collector-dev] ${message}\n`);
}

function hasArg(args, flag) {
  return args.includes(flag);
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

async function readTokenFromDataDir(dataDir) {
  const tokenPath = path.join(dataDir, "secret", "token");
  try {
    const raw = await fs.readFile(tokenPath, "utf8");
    const token = String(raw ?? "").trim();
    return token ? token : null;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readSettingsFromAgent({ agentUrl, token }) {
  if (!token) return null;
  try {
    const res = await fetch(`${agentUrl}/v1/settings`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log(`读取 Agent settings 失败（${res.status}）：${text}`);
      return null;
    }

    const body = await res.json();
    return body?.settings ?? null;
  } catch (error) {
    log(`读取 Agent settings 失败：${String(error)}`);
    return null;
  }
}

function buildArgsFromSettings(settings, { baseArgs }) {
  const args = [...baseArgs];

  const collector = settings?.collector ?? null;
  if (!collector || typeof collector !== "object") return args;

  // 仅当用户没有显式传入对应参数时，才从 settings 注入默认值（CLI > settings）。
  if (!hasArg(args, "--interval") && Number.isFinite(Number(collector.intervalSeconds))) {
    args.push("--interval", String(collector.intervalSeconds));
  }

  if (!hasArg(args, "--dedupe-threshold") && Number.isFinite(Number(collector.dedupeThreshold))) {
    args.push("--dedupe-threshold", String(collector.dedupeThreshold));
  }

  if (!hasArg(args, "--ocr-level") && typeof collector.ocrLevel === "string" && collector.ocrLevel.trim() !== "") {
    args.push("--ocr-level", collector.ocrLevel.trim());
  }

  if (!hasArg(args, "--ocr-lang") && Array.isArray(collector.ocrLanguages) && collector.ocrLanguages.length > 0) {
    const langs = collector.ocrLanguages
      .map((x) => String(x ?? "").trim())
      .filter((x) => x !== "");
    if (langs.length > 0) {
      args.push("--ocr-lang", langs.join(","));
    }
  }

  const hasExclude =
    hasArg(args, "--exclude-app") ||
    hasArg(args, "--exclude-apps");
  if (!hasExclude && Array.isArray(collector.excludedApps) && collector.excludedApps.length > 0) {
    for (const app of collector.excludedApps) {
      const trimmed = String(app ?? "").trim();
      if (!trimmed) continue;
      args.push("--exclude-app", trimmed);
    }
  }

  return args;
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

  const token =
    (process.env.RECAPSENSE_API_TOKEN && String(process.env.RECAPSENSE_API_TOKEN).trim()) ||
    (await readTokenFromDataDir(dataDir));
  const settings = await readSettingsFromAgent({ agentUrl, token });

  const finalArgs = buildArgsFromSettings(settings, { baseArgs: filteredArgs });

  log(`启动 collector（dataDir=${dataDir}）…`);
  if (settings) {
    log("已从 Agent settings 注入默认参数（CLI 显式参数优先）。");
  }
  await spawnProcess(binaryPath, finalArgs, {
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

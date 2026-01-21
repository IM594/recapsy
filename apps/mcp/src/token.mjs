import fs from "node:fs/promises";
import path from "node:path";

import { resolveDataDir } from "./paths.mjs";

async function readTextFile(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content.trim();
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error(
        `未找到 RecapSense token 文件：${filePath}。请先启动一次 agent 完成初始化。`
      );
    }
    throw error;
  }
}

export async function loadAgentToken() {
  const fromEnv = process.env.RECAPSENSE_API_TOKEN;
  if (fromEnv && fromEnv.trim() !== "") {
    return fromEnv.trim();
  }

  const dataDir = resolveDataDir();
  const tokenPath = path.join(dataDir, "secret", "token");
  return readTextFile(tokenPath);
}

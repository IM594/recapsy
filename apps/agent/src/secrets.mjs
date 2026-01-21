import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { tokenFilePath } from "./paths.mjs";

async function readTextFileIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function loadOrCreateApiToken(dataDir) {
  const fromEnv = process.env.RECAPSENSE_API_TOKEN;
  const tokenPath = tokenFilePath(dataDir);

  const existing = await readTextFileIfExists(tokenPath);
  if (existing && existing.trim() !== "") {
    return existing.trim();
  }

  const token = (fromEnv && fromEnv.trim() !== "")
    ? fromEnv.trim()
    : crypto.randomBytes(32).toString("base64url");

  await fs.mkdir(path.dirname(tokenPath), { recursive: true });
  await fs.writeFile(tokenPath, token + "\n", { mode: 0o600 });

  return token;
}


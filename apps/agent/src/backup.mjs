import fs from "node:fs/promises";
import path from "node:path";

import { dbFilePath } from "./paths.mjs";
import { ulid } from "./ids.mjs";

function escapeSqliteString(value) {
  return String(value ?? "").replace(/'/g, "''");
}

async function removeFileIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
}

function isVacuumIntoUnsupported(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("near \"INTO\"") || message.includes("syntax error");
}

async function copyDatabaseFileSnapshot({ db, dataDir, snapshotPath }) {
  // fallback：某些 SQLite 构建不支持 `VACUUM INTO`。
  // 策略：持有写锁 -> checkpoint + truncate WAL -> 直接 copy 主 db 文件。
  // 说明：这是“尽力而为”的一致性快照；对于本项目（单实例写入），足够可靠。
  const sourceDb = dbFilePath(dataDir);

  db.exec("BEGIN IMMEDIATE");
  try {
    try {
      db.prepare("PRAGMA wal_checkpoint(TRUNCATE);").get();
    } catch {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    }
    await fs.copyFile(sourceDb, snapshotPath);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback error
    }
    throw error;
  }
}

export async function createDatabaseSnapshot({ db, dataDir } = {}) {
  if (!db) {
    throw new Error("db is required");
  }
  const root = String(dataDir ?? "").trim();
  if (!root) {
    throw new Error("dataDir is required");
  }

  const snapshotsDir = path.join(root, "tmp", "snapshots");
  await fs.mkdir(snapshotsDir, { recursive: true });

  const snapshotPath = path.join(snapshotsDir, `recapsense-${ulid()}.db`);
  await removeFileIfExists(snapshotPath);

  try {
    db.exec(`VACUUM INTO '${escapeSqliteString(snapshotPath)}';`);
    return snapshotPath;
  } catch (error) {
    if (!isVacuumIntoUnsupported(error)) {
      await removeFileIfExists(snapshotPath);
      throw error;
    }

    try {
      await copyDatabaseFileSnapshot({ db, dataDir: root, snapshotPath });
      return snapshotPath;
    } catch (fallbackError) {
      await removeFileIfExists(snapshotPath);
      throw fallbackError;
    }
  }
}


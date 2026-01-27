import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { openDatabase } from "../src/db.mjs";
import { createDatabaseSnapshot } from "../src/backup.mjs";
import { dbFilePath } from "../src/paths.mjs";

async function makeTempDir(prefix = "recapsense-backup-branches-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeFakeDb({ onPrepare, onExec } = {}) {
  return {
    exec(sql) {
      onExec?.(sql);
    },
    prepare(sql) {
      return onPrepare?.(sql) ?? { get() { return null; } };
    },
  };
}

test("backup: createDatabaseSnapshot validates arguments", async () => {
  await assert.rejects(() => createDatabaseSnapshot({}), /db is required/);
  await assert.rejects(() => createDatabaseSnapshot({ db: {} }), /dataDir is required/);
});

test("backup: fallback copy path when VACUUM INTO unsupported (prepare path)", async () => {
  const dataDir = path.join(await makeTempDir(), "recap'sense");
  await fs.mkdir(dataDir, { recursive: true });

  const { db } = await openDatabase(dataDir);
  // 让 db 文件真实存在
  db.exec("CREATE TABLE IF NOT EXISTS t(x);");

  const calls = [];
  const fakeDb = makeFakeDb({
    onExec: (sql) => {
      calls.push(sql);
      if (String(sql).startsWith("VACUUM INTO")) {
        throw new Error('near "INTO": syntax error');
      }
    },
    onPrepare: (sql) => {
      calls.push(sql);
      return { get() { return null; } };
    },
  });

  const snapshotPath = await createDatabaseSnapshot({ db: fakeDb, dataDir });
  const stat = await fs.stat(snapshotPath);
  assert.ok(stat.size > 0);

  // 覆盖：BEGIN IMMEDIATE / COMMIT 以及 wal_checkpoint (prepare)
  assert.ok(calls.some((c) => String(c).includes("BEGIN IMMEDIATE")));
  assert.ok(calls.some((c) => String(c).includes("wal_checkpoint")));
  assert.ok(calls.some((c) => String(c).includes("COMMIT")));

  if (typeof db.close === "function") db.close();
});

test("backup: fallback copy path when PRAGMA prepare fails (exec path)", async () => {
  const dataDir = await makeTempDir("recapsense-backup-branches-2-");
  const { db } = await openDatabase(dataDir);
  db.exec("CREATE TABLE IF NOT EXISTS t(x);");

  const calls = [];
  const fakeDb = makeFakeDb({
    onExec: (sql) => {
      calls.push(sql);
      if (String(sql).startsWith("VACUUM INTO")) {
        throw new Error('near "INTO": syntax error');
      }
    },
    onPrepare: (sql) => {
      calls.push(sql);
      if (String(sql).includes("wal_checkpoint")) {
        throw new Error("prepare failed");
      }
      return { get() { return null; } };
    },
  });

  const snapshotPath = await createDatabaseSnapshot({ db: fakeDb, dataDir });
  const stat = await fs.stat(snapshotPath);
  assert.ok(stat.size > 0);

  assert.ok(calls.some((c) => String(c).includes("PRAGMA wal_checkpoint(TRUNCATE)")));

  if (typeof db.close === "function") db.close();
});

test("backup: fallback removes snapshot when copy fails and rolls back", async () => {
  const dataDir = await makeTempDir("recapsense-backup-branches-3-");

  // 确保 source db 不存在 -> copyFile 会失败
  await fs.rm(path.join(dataDir, "db"), { recursive: true, force: true });
  const sourceDb = dbFilePath(dataDir);
  await assert.rejects(() => fs.stat(sourceDb), () => true);

  let rollbackCalled = false;
  const fakeDb = makeFakeDb({
    onExec: (sql) => {
      if (String(sql).startsWith("VACUUM INTO")) {
        throw new Error('near "INTO": syntax error');
      }
      if (String(sql).includes("ROLLBACK")) rollbackCalled = true;
    },
    onPrepare: (sql) => {
      if (String(sql).includes("wal_checkpoint")) {
        return { get() { return null; } };
      }
      return { get() { return null; } };
    },
  });

  let snapshotPath = null;
  try {
    snapshotPath = await createDatabaseSnapshot({ db: fakeDb, dataDir });
    throw new Error("expected createDatabaseSnapshot to fail");
  } catch (error) {
    assert.ok(rollbackCalled);
    // snapshot 文件应被清理（即使我们拿不到具体名字，也可通过目录为空验证）
    const dir = path.join(dataDir, "tmp", "snapshots");
    const entries = await fs.readdir(dir).catch(() => []);
    assert.equal(entries.length, 0);
    assert.ok(error instanceof Error);
  }

  assert.equal(snapshotPath, null);
});

test("backup: removeFileIfExists rethrows non-ENOENT errors", async (t) => {
  const dataDir = await makeTempDir("recapsense-backup-branches-4-");
  const fakeDb = makeFakeDb();

  const original = fs.unlink;
  t.mock.method(fs, "unlink", async (filePath) => {
    const target = String(filePath ?? "");
    if (target.includes(`${path.sep}tmp${path.sep}snapshots${path.sep}`)) {
      const error = new Error("unlink denied");
      error.code = "EACCES";
      throw error;
    }
    return original(filePath);
  });

  await assert.rejects(
    () => createDatabaseSnapshot({ db: fakeDb, dataDir }),
    /unlink denied/
  );
});

test("backup: VACUUM failures not due to INTO are rethrown (and snapshot is cleaned)", async () => {
  const dataDir = await makeTempDir("recapsense-backup-branches-5-");
  const fakeDb = makeFakeDb({
    onExec: (sql) => {
      if (String(sql).startsWith("VACUUM INTO")) {
        throw new Error("disk I/O error");
      }
    },
  });

  await assert.rejects(
    () => createDatabaseSnapshot({ db: fakeDb, dataDir }),
    /disk I\/O error/
  );

  const dir = path.join(dataDir, "tmp", "snapshots");
  const entries = await fs.readdir(dir).catch(() => []);
  assert.equal(entries.length, 0);
});

test("backup: rollback errors are ignored when copy snapshot fails", async () => {
  const dataDir = await makeTempDir("recapsense-backup-branches-6-");
  await fs.rm(path.join(dataDir, "db"), { recursive: true, force: true });
  const sourceDb = dbFilePath(dataDir);
  await assert.rejects(() => fs.stat(sourceDb), () => true);

  const fakeDb = makeFakeDb({
    onExec: (sql) => {
      if (String(sql).startsWith("VACUUM INTO")) {
        throw new Error('near "INTO": syntax error');
      }
      if (String(sql).includes("ROLLBACK")) {
        throw new Error("rollback boom");
      }
    },
  });

  await assert.rejects(() => createDatabaseSnapshot({ db: fakeDb, dataDir }), () => true);

  const dir = path.join(dataDir, "tmp", "snapshots");
  const entries = await fs.readdir(dir).catch(() => []);
  assert.equal(entries.length, 0);
});

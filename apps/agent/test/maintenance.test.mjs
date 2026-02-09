import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createEvidenceMaintenance } from "../src/maintenance.mjs";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "recapsense-maintenance-test-"));
}

test("maintenance: resolveSafePath enforces dataDir scope", async () => {
  const dataDir = await makeTempDir();
  const store = { getSettings: () => ({ agent: {}, collector: {} }) };
  const evidence = createEvidenceMaintenance({ dataDir, getStore: () => store });

  assert.equal(evidence.resolveSafePath(""), null);
  assert.equal(evidence.resolveSafePath(null), null);
  assert.equal(evidence.resolveSafePath("/etc/passwd"), null);
  assert.equal(evidence.resolveSafePath("../escape.txt"), null);

  const abs = evidence.resolveSafePath("media/screenshots/a.webp");
  assert.ok(abs);
  assert.ok(abs.startsWith(path.resolve(dataDir) + path.sep));
});

test("maintenance: getMediaStats caches and supports refresh", async () => {
  const dataDir = await makeTempDir();
  const mediaDir = path.join(dataDir, "media", "screenshots", "2000-01-01");
  await fs.mkdir(mediaDir, { recursive: true });
  await fs.writeFile(path.join(mediaDir, "a.txt"), "hello");

  const store = {
    getSettings: () => ({
      agent: { mediaWarnThresholdBytes: 1 },
      collector: {},
    }),
  };

  const evidence = createEvidenceMaintenance({ dataDir, getStore: () => store });

  const first = await evidence.getMediaStats({ refresh: true });
  assert.ok(first.totalBytes >= 5);
  assert.equal(first.overThreshold, true);

  await fs.writeFile(path.join(mediaDir, "b.txt"), "world!");

  const cached = await evidence.getMediaStats({ refresh: false });
  assert.equal(cached, first);

  const refreshed = await evidence.getMediaStats({ refresh: true });
  assert.ok(refreshed.totalBytes >= first.totalBytes);
  assert.notEqual(refreshed, first);
});

test("maintenance: getMediaStats handles missing media directory (ENOENT)", async () => {
  const dataDir = await makeTempDir();

  const store = {
    getSettings: () => ({
      agent: { mediaWarnThresholdBytes: 1 },
      collector: {},
    }),
  };

  const evidence = createEvidenceMaintenance({ dataDir, getStore: () => store });
  const stats = await evidence.getMediaStats({ refresh: true });
  assert.equal(stats.totalBytes, 0);
  assert.equal(stats.fileCount, 0);
});

test("maintenance: maybeWarnMediaSize respects threshold and cooldown", async () => {
  const dataDir = await makeTempDir();
  const mediaDir = path.join(dataDir, "media");
  await fs.mkdir(mediaDir, { recursive: true });
  await fs.writeFile(path.join(mediaDir, "x.bin"), Buffer.alloc(8));

  let warns = 0;
  const logger = { warn: () => { warns += 1; } };

  const store = {
    getSettings: () => ({
      agent: { mediaWarnThresholdBytes: 1 },
      collector: {},
    }),
  };
  const evidence = createEvidenceMaintenance({ dataDir, getStore: () => store, logger });

  await evidence.maybeWarnMediaSize();
  await evidence.maybeWarnMediaSize();
  assert.equal(warns, 1);
});

test("maintenance: cleanupEvidence deletes only safe file paths and counts skipped/errors", async () => {
  const dataDir = await makeTempDir();

  // 创建 1 个可删除文件 + 1 个目录（unlink 会 EISDIR 走 error 分支）+ 1 个越界路径（走 skippedPaths）
  const goodRel = "media/screenshots/2000-01-01/good.webp";
  const dirRel = "media/screenshots/2000-01-01/dir-as-file";
  await fs.mkdir(path.join(dataDir, "media", "screenshots", "2000-01-01"), { recursive: true });
  await fs.writeFile(path.join(dataDir, goodRel), "ok");
  await fs.mkdir(path.join(dataDir, dirRel), { recursive: true });

  const store = {
    getSettings: () => ({
      agent: { evidenceRetentionDays: 365, mediaWarnThresholdBytes: 0 },
      collector: {},
    }),
    expireChunkedFrameMedia: () => ({
      clearedFrames: 2,
      filePaths: [goodRel, dirRel, "media/screenshots/2000-01-01/missing.webp", "/etc/passwd", "../escape.txt"],
    }),
  };

  const errors = [];
  const logger = { warn: (...args) => errors.push(args.join(" ")) };

  const evidence = createEvidenceMaintenance({ dataDir, getStore: () => store, logger });
  const result = await evidence.cleanupEvidence({ retentionDays: 365, maxFramesPerRun: 100 });

  assert.equal(result.clearedFrames, 2);
  assert.equal(result.deletedFiles, 1);
  assert.ok(result.skippedPaths >= 2);
  assert.ok(result.fileErrors >= 1);

  await assert.rejects(
    () => fs.stat(path.join(dataDir, goodRel)),
    (e) => e && typeof e === "object" && e.code === "ENOENT"
  );
});

test("maintenance: deleteEvidenceFiles ignores missing files and skips unsafe paths", async () => {
  const dataDir = await makeTempDir();
  const rel = "media/screenshots/2000-01-01/a.webp";
  await fs.mkdir(path.join(dataDir, "media", "screenshots", "2000-01-01"), { recursive: true });
  await fs.writeFile(path.join(dataDir, rel), "ok");

  const store = { getSettings: () => ({ agent: {}, collector: {} }) };
  const evidence = createEvidenceMaintenance({ dataDir, getStore: () => store });

  const result = await evidence.deleteEvidenceFiles([rel, rel, "/etc/passwd", "../escape.txt"]);
  assert.equal(result.deletedFiles, 1);
  assert.ok(result.skippedPaths >= 2);
  assert.equal(result.fileErrors, 0);

  // 再删一次：ENOENT 应被忽略
  const result2 = await evidence.deleteEvidenceFiles([rel]);
  assert.equal(result2.deletedFiles, 0);
  assert.equal(result2.fileErrors, 0);
});

test("maintenance: deleteMediaDirectory removes dataDir/media", async () => {
  const dataDir = await makeTempDir();
  const store = { getSettings: () => ({ agent: {}, collector: {} }) };
  const evidence = createEvidenceMaintenance({ dataDir, getStore: () => store });

  const mediaDir = path.join(dataDir, "media", "screenshots");
  await fs.mkdir(mediaDir, { recursive: true });
  await fs.writeFile(path.join(mediaDir, "a.txt"), "x");

  const result = await evidence.deleteMediaDirectory();
  assert.equal(result.ok, true);

  await assert.rejects(
    () => fs.stat(path.join(dataDir, "media")),
    (e) => e && typeof e === "object" && e.code === "ENOENT"
  );
});

test("maintenance: getMediaStats throws when Agent is starting", async () => {
  const dataDir = await makeTempDir();
  const evidence = createEvidenceMaintenance({ dataDir, getStore: () => null });
  await assert.rejects(() => evidence.getMediaStats({ refresh: true }), /Agent is starting/);
});

test("maintenance: getMediaStats throws on readdir non-ENOENT error", async (t) => {
  const dataDir = await makeTempDir();
  const mediaDir = path.join(dataDir, "media");
  await fs.mkdir(mediaDir, { recursive: true });

  const original = fs.readdir;
  t.mock.method(fs, "readdir", async (...args) => {
    const dir = String(args[0] ?? "");
    if (dir === mediaDir) {
      const error = new Error("boom");
      error.code = "EACCES";
      throw error;
    }
    return original(...args);
  });

  const store = { getSettings: () => ({ agent: { mediaWarnThresholdBytes: 1 }, collector: {} }) };
  const evidence = createEvidenceMaintenance({ dataDir, getStore: () => store });
  await assert.rejects(() => evidence.getMediaStats({ refresh: true }), /boom/);
});

test("maintenance: getMediaStats throws on stat non-ENOENT error", async (t) => {
  const dataDir = await makeTempDir();
  const mediaDir = path.join(dataDir, "media");
  await fs.mkdir(mediaDir, { recursive: true });
  const filePath = path.join(mediaDir, "a.txt");
  await fs.writeFile(filePath, "hello");

  const original = fs.stat;
  t.mock.method(fs, "stat", async (...args) => {
    const target = String(args[0] ?? "");
    if (target === filePath) {
      const error = new Error("stat boom");
      error.code = "EACCES";
      throw error;
    }
    return original(...args);
  });

  const store = { getSettings: () => ({ agent: { mediaWarnThresholdBytes: 1 }, collector: {} }) };
  const evidence = createEvidenceMaintenance({ dataDir, getStore: () => store });
  await assert.rejects(() => evidence.getMediaStats({ refresh: true }), /stat boom/);
});

test("maintenance: maybeWarnMediaSize formats bytes with units (>= KB)", async () => {
  const dataDir = await makeTempDir();
  const mediaDir = path.join(dataDir, "media");
  await fs.mkdir(mediaDir, { recursive: true });

  const big = path.join(mediaDir, "big.bin");
  await fs.writeFile(big, "x");
  await fs.truncate(big, 11 * 1024);

  const messages = [];
  const logger = { warn: (msg) => messages.push(String(msg)) };

  const store = {
    getSettings: () => ({
      agent: { mediaWarnThresholdBytes: 1 },
      collector: {},
    }),
  };
  const evidence = createEvidenceMaintenance({ dataDir, getStore: () => store, logger });

  await evidence.maybeWarnMediaSize();

  assert.equal(messages.length, 1);
  assert.match(messages[0], /(KB|MB|GB|TB)/);
});

test("maintenance: deleteEvidenceFiles counts non-ENOENT unlink errors", async (t) => {
  const dataDir = await makeTempDir();
  const rel = "media/screenshots/2000-01-01/a.webp";
  const abs = path.join(dataDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, "ok");

  const original = fs.unlink;
  t.mock.method(fs, "unlink", async (...args) => {
    const target = String(args[0] ?? "");
    if (target === abs) {
      const error = new Error("unlink boom");
      error.code = "EACCES";
      throw error;
    }
    return original(...args);
  });

  const warns = [];
  const logger = { warn: (...args) => warns.push(args.map(String).join(" ")) };

  const store = { getSettings: () => ({ agent: {}, collector: {} }) };
  const evidence = createEvidenceMaintenance({ dataDir, getStore: () => store, logger });

  const result = await evidence.deleteEvidenceFiles([rel]);
  assert.equal(result.deletedFiles, 0);
  assert.equal(result.fileErrors, 1);
  assert.ok(warns.length >= 1);
});

test("maintenance: deleteMediaDirectory returns ok=false when rm fails", async (t) => {
  const dataDir = await makeTempDir();
  const store = { getSettings: () => ({ agent: {}, collector: {} }) };
  const evidence = createEvidenceMaintenance({ dataDir, getStore: () => store, logger: { warn: () => {} } });

  t.mock.method(fs, "rm", async () => {
    throw new Error("rm boom");
  });

  const result = await evidence.deleteMediaDirectory();
  assert.equal(result.ok, false);
});

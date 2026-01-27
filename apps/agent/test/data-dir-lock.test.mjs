import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { acquireDataDirLock, __test as lockTest, removeFileIfExists } from "../src/data-dir-lock.mjs";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recapsense-agent-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("acquireDataDirLock: 同一 dataDir 二次获取会拒绝", async () => {
  await withTempDir(async (dataDir) => {
    const first = await acquireDataDirLock({
      dataDir,
      label: "agent",
      serviceName: "test",
      installProcessHandlers: false,
    });

    const raw = await fs.readFile(first.lockFile, "utf8");
    assert.match(raw, /"pid":/);

    await assert.rejects(
      () =>
        acquireDataDirLock({
          dataDir,
          label: "agent",
          serviceName: "test",
          installProcessHandlers: false,
        }),
      /同一数据目录/
    );
  });
});

test("acquireDataDirLock: stale pid 会自动清理并重试", async () => {
  await withTempDir(async (dataDir) => {
    const lockFile = path.join(dataDir, "run", "agent.lock");
    await fs.mkdir(path.dirname(lockFile), { recursive: true });

    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 10000)"], {
      stdio: "ignore",
    });
    assert.ok(child.pid, "child pid should exist");

    await fs.writeFile(
      lockFile,
      `${JSON.stringify({ pid: child.pid, service: "other" }, null, 2)}\n`,
      "utf8"
    );

    await assert.rejects(
      () =>
        acquireDataDirLock({
          dataDir,
          label: "agent",
          serviceName: "test",
          installProcessHandlers: false,
        }),
      /同一数据目录/
    );

    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));

    const acquired = await acquireDataDirLock({
      dataDir,
      label: "agent",
      serviceName: "test",
      installProcessHandlers: false,
    });

    const raw = await fs.readFile(acquired.lockFile, "utf8");
    const payload = JSON.parse(raw);
    assert.equal(payload.pid, process.pid);
  });
});

test("data-dir-lock: 输入校验与解析分支", async () => {
  await assert.rejects(() => acquireDataDirLock(), /dataDir is required/);
  await assert.rejects(() => acquireDataDirLock({ dataDir: "/tmp" }), /label is required/);

  assert.equal(lockTest.isPidAlive(null), false);
  assert.equal(lockTest.isPidAlive(0), false);
  assert.equal(lockTest.isPidAlive(1), false);

  assert.equal(lockTest.parsePidFromLockPayload("123\n"), 123);
  assert.equal(lockTest.parsePidFromLockPayload("{\"pid\": 456}"), 456);
  assert.equal(lockTest.parsePidFromLockPayload("{not-json"), null);
  assert.equal(lockTest.parsePidFromLockPayload(""), null);

  await withTempDir(async (dataDir) => {
    const missing = path.join(dataDir, "run", "nope.lock");
    await removeFileIfExists(missing);
  });
});

test("acquireDataDirLock: installProcessHandlers=true 也可用", async () => {
  await withTempDir(async (dataDir) => {
    const { lockFile } = await acquireDataDirLock({
      dataDir,
      label: "agent",
      serviceName: "test",
      installProcessHandlers: true,
    });
    const raw = await fs.readFile(lockFile, "utf8");
    const payload = JSON.parse(raw);
    assert.equal(payload.pid, process.pid);
  });
});

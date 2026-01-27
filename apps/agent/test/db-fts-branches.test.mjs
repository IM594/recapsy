import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { __test } from "../src/db.mjs";

function withEnv(nextEnv, fn) {
  const previous = {};
  for (const key of Object.keys(nextEnv)) {
    previous[key] = process.env[key];
    process.env[key] = nextEnv[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(nextEnv)) {
        if (previous[key] == null) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
}

function makeFakeDbForFts({
  chunksFtsExists = false,
  throwOnFts5,
  throwOnFts4,
} = {}) {
  const execCalls = [];
  return {
    execCalls,
    prepare(sql) {
      const text = String(sql);
      if (text.includes("FROM sqlite_master") && text.includes("WHERE type='table'")) {
        return {
          get(name) {
            if (String(name) === "chunks_fts" && chunksFtsExists) return { ok: 1 };
            return null;
          },
        };
      }
      throw new Error(`unexpected prepare: ${sql}`);
    },
    exec(sql) {
      const text = String(sql);
      execCalls.push(text);
      if (text.includes("USING fts5") && throwOnFts5) throw throwOnFts5;
      if (text.includes("USING fts4") && throwOnFts4) throw throwOnFts4;
    },
  };
}

test("db __test: isNoSuchModuleError detects missing modules", async () => {
  assert.equal(__test.isNoSuchModuleError(new Error("no such module: fts5"), "fts5"), true);
  assert.equal(__test.isNoSuchModuleError("no such module: fts4", "fts4"), true);
  assert.equal(__test.isNoSuchModuleError(new Error("boom"), "fts5"), false);
});

test("db __test: ensureChunksFts respects disable env", async () => {
  await withEnv({ RECAPSENSE_DISABLE_FTS: "1" }, async () => {
    const db = makeFakeDbForFts();
    const result = __test.ensureChunksFts(db);
    assert.deepEqual(result, { ok: true, mode: null, reason: "disabled" });
  });
});

test("db __test: ensureChunksFts returns existing when chunks_fts already exists", async () => {
  await withEnv({ RECAPSENSE_DISABLE_FTS: "" }, async () => {
    const db = makeFakeDbForFts({ chunksFtsExists: true });
    const result = __test.ensureChunksFts(db);
    assert.equal(result.ok, true);
    assert.equal(result.mode, "existing");
  });
});

test("db __test: ensureChunksFts falls back from fts5 missing to fts4", async () => {
  await withEnv({ RECAPSENSE_DISABLE_FTS: "" }, async () => {
    const db = makeFakeDbForFts({
      throwOnFts5: new Error("no such module: fts5"),
      throwOnFts4: null,
    });
    const result = __test.ensureChunksFts(db);
    assert.equal(result.ok, true);
    assert.equal(result.mode, "fts4");
  });
});

test("db __test: ensureChunksFts returns no-fts-module when both missing", async () => {
  await withEnv({ RECAPSENSE_DISABLE_FTS: "" }, async () => {
    const db = makeFakeDbForFts({
      throwOnFts5: new Error("no such module: fts5"),
      throwOnFts4: new Error("no such module: fts4"),
    });
    const result = __test.ensureChunksFts(db);
    assert.equal(result.ok, true);
    assert.equal(result.mode, null);
    assert.equal(result.reason, "no-fts-module");
  });
});

test("db __test: fileExists true/false and throws on unexpected stat errors", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recapsense-db-fileexists-"));
  const filePath = path.join(dir, "a.txt");
  await fs.writeFile(filePath, "ok");

  assert.equal(await __test.fileExists(filePath), true);
  assert.equal(await __test.fileExists(path.join(dir, "missing.txt")), false);

  const original = fs.stat;
  t.mock.method(fs, "stat", async () => {
    const error = new Error("stat boom");
    error.code = "EACCES";
    throw error;
  });
  await assert.rejects(() => __test.fileExists(filePath), /stat boom/);
});

test("db __test: withTransaction rolls back and ignores rollback errors", async () => {
  const calls = [];
  const db = {
    exec(sql) {
      calls.push(String(sql));
      if (String(sql) === "ROLLBACK") throw new Error("rollback boom");
    },
  };

  assert.throws(
    () => __test.withTransaction(db, () => { throw new Error("tx boom"); }),
    /tx boom/
  );
  assert.ok(calls.includes("BEGIN IMMEDIATE"));
  assert.ok(calls.includes("ROLLBACK"));
});

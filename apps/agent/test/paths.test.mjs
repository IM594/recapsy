import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { resolveDataDir, resolveDefaultMacOSDataDir, tokenFilePath, dbFilePath } from "../src/paths.mjs";

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
        if (previous[key] == null) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    });
}

test("agent paths: resolveDataDir uses env when set", async () => {
  await withEnv({ RECAPSENSE_DATA_DIR: "/tmp/recapsense-agent-paths" }, async () => {
    assert.equal(resolveDataDir(), "/tmp/recapsense-agent-paths");
  });
});

test("agent paths: resolveDataDir defaults to .recapsense under cwd", async () => {
  await withEnv({ RECAPSENSE_DATA_DIR: "" }, async () => {
    assert.ok(resolveDataDir().endsWith(path.join(process.cwd(), ".recapsense")));
  });
});

test("agent paths: resolveDefaultMacOSDataDir uses ~/Library/Application Support/RecapSense", () => {
  const dir = resolveDefaultMacOSDataDir();
  assert.match(dir, /Library\/Application Support\/RecapSense$/);
});

test("agent paths: tokenFilePath/dbFilePath join under dataDir", () => {
  assert.equal(tokenFilePath("/data"), path.join("/data", "secret", "token"));
  assert.equal(dbFilePath("/data"), path.join("/data", "db", "recapsense.db"));
});


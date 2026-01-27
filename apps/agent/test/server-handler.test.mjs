import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";

import { openDatabase } from "../src/db.mjs";
import { createStore } from "../src/store.mjs";
import { createAgentRequestHandler } from "../src/agent-handler.mjs";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "recapsense-agent-handler-test-"));
}

class MockResponse extends Writable {
  statusCode = null;
  headers = {};
  #chunks = [];

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = { ...this.headers, ...(headers ?? {}) };
    return this;
  }

  _write(chunk, _encoding, callback) {
    this.#chunks.push(Buffer.from(chunk));
    callback();
  }

  body() {
    return Buffer.concat(this.#chunks);
  }
}

class ThrowingEndResponse extends MockResponse {
  end(...args) {
    super.end(...args);
    throw new Error("end boom");
  }
}

function makeRequest({ method, url, headers, body }) {
  const stream = body == null ? Readable.from([]) : Readable.from([Buffer.from(body)]);
  stream.method = method;
  stream.url = url;
  stream.headers = headers ?? {};
  return stream;
}

async function run(handler, req) {
  const res = new MockResponse();
  const done = once(res, "finish");
  await handler(req, res);
  await done;
  return res;
}

function parseJson(res) {
  const text = res.body().toString("utf8");
  return JSON.parse(text);
}

test("agent handler: auth, errors, core routes（无端口监听）", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const token = "test-token";
  let shutdownCalled = 0;

  const maintenance = {
    async cleanupEvidence() {
      return { clearedFrames: 0, deletedFiles: 0, fileErrors: 0, retentionDays: 365 };
    },
    async getMediaStats() {
      return { totalBytes: 0, fileCount: 0, thresholdBytes: 0, overThreshold: false, scannedAt: Date.now() };
    },
    async deleteEvidenceFiles() {
      return { deletedFiles: 0, skippedPaths: 0, fileErrors: 0 };
    },
    async deleteMediaDirectory() {
      return { ok: true, mediaDir: "(mock)" };
    },
    async maybeWarnMediaSize() {},
  };

  const handler = createAgentRequestHandler({
    host: "127.0.0.1",
    serviceName: "recapsense-agent",
    dataDir,
    token,
    getStore: () => store,
    getDb: () => db,
    maintenance,
    onShutdown: () => {
      shutdownCalled += 1;
    },
  });

  // health：无需 token
  {
    const res = await run(handler, makeRequest({
      method: "GET",
      url: "/health",
      headers: { host: "127.0.0.1" },
    }));
    assert.equal(res.statusCode, 200);
    const body = parseJson(res);
    assert.equal(body.ok, true);
    assert.equal(body.service, "recapsense-agent");
    assert.ok(Number.isFinite(body.pid));
  }

  // 非 /v1：404
  {
    const res = await run(handler, makeRequest({
      method: "GET",
      url: "/not-found",
      headers: { host: "127.0.0.1" },
    }));
    assert.equal(res.statusCode, 404);
    const body = parseJson(res);
    assert.equal(body.error, "Not found");
  }

  // /v1：必须 token
  {
    const res = await run(handler, makeRequest({
      method: "GET",
      url: "/v1/settings",
      headers: { host: "127.0.0.1" },
    }));
    assert.equal(res.statusCode, 401);
    const body = parseJson(res);
    assert.equal(body.error, "Unauthorized");
  }

  // /v1 unknown route：404
  {
    const res = await run(handler, makeRequest({
      method: "GET",
      url: "/v1/unknown",
      headers: { host: "127.0.0.1", authorization: `Bearer ${token}` },
    }));
    assert.equal(res.statusCode, 404);
  }

  // Invalid JSON：400
  {
    const res = await run(handler, makeRequest({
      method: "PATCH",
      url: "/v1/settings",
      headers: {
        host: "127.0.0.1",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: "{",
    }));
    assert.equal(res.statusCode, 400);
    const body = parseJson(res);
    assert.equal(body.error, "Invalid JSON");
  }

  // Body too large：413
  {
    const payload = JSON.stringify({ x: "a".repeat(1_000_100) });
    const res = await run(handler, makeRequest({
      method: "PATCH",
      url: "/v1/settings",
      headers: {
        host: "127.0.0.1",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: payload,
    }));
    assert.equal(res.statusCode, 413);
    const body = parseJson(res);
    assert.equal(body.error, "Request body too large");
  }

  // Agent starting：503（store=null）
  {
    const handlerStarting = createAgentRequestHandler({
      host: "127.0.0.1",
      serviceName: "recapsense-agent",
      dataDir,
      token,
      getStore: () => null,
      getDb: () => db,
      maintenance,
    });

    const res = await run(handlerStarting, makeRequest({
      method: "GET",
      url: "/v1/settings",
      headers: { host: "127.0.0.1", authorization: `Bearer ${token}` },
    }));
    assert.equal(res.statusCode, 503);
    const body = parseJson(res);
    assert.equal(body.error, "Agent is starting");
  }

  // settings：GET/PATCH
  {
    const getRes = await run(handler, makeRequest({
      method: "GET",
      url: "/v1/settings",
      headers: { host: "127.0.0.1", authorization: `Bearer ${token}` },
    }));
    assert.equal(getRes.statusCode, 200);
    const getBody = parseJson(getRes);
    assert.ok(getBody.settings);

    const patchRes = await run(handler, makeRequest({
      method: "PATCH",
      url: "/v1/settings",
      headers: {
        host: "127.0.0.1",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        collector: { excludedApps: ["com.recapsense.secret"] },
      }),
    }));
    assert.equal(patchRes.statusCode, 200);
    const patchBody = parseJson(patchRes);
    assert.deepEqual(patchBody.settings.collector.excludedApps, ["com.recapsense.secret"]);
  }

  // ingest/frame：202 skipped (excluded app)
  {
    const res = await run(handler, makeRequest({
      method: "POST",
      url: "/v1/ingest/frame",
      headers: {
        host: "127.0.0.1",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ts: Date.now(),
        app: "SecretApp",
        appBundleId: "com.recapsense.secret",
        windowTitle: "Secret",
        ocrText: "should not be stored",
      }),
    }));
    assert.equal(res.statusCode, 202);
    const body = parseJson(res);
    assert.equal(body.frame?.skipped, true);
    assert.equal(body.frame?.reason, "excluded-app");
  }

  // ingest/frame：200 ok (非 excluded app)
  {
    const res = await run(handler, makeRequest({
      method: "POST",
      url: "/v1/ingest/frame",
      headers: {
        host: "127.0.0.1",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ts: Date.now(),
        app: "DemoApp",
        appBundleId: "com.demo.app",
        windowTitle: "Demo Window",
        ocrText: "hello from frame",
        phash: "deadbeef",
      }),
    }));
    assert.equal(res.statusCode, 200);
    const body = parseJson(res);
    assert.ok(body.frame);
    assert.equal(body.frame.skipped, undefined);
  }

  // ingest/chunk + search + get_chunk
  let insertedChunkId = null;
  {
    const now = Date.now();
    const chunkRes = await run(handler, makeRequest({
      method: "POST",
      url: "/v1/ingest/chunk",
      headers: {
        host: "127.0.0.1",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        startTs: now - 2000,
        endTs: now - 1000,
        app: "DemoApp",
        windowTitle: "Hello",
        text: "hello world from agent handler test",
      }),
    }));
    assert.equal(chunkRes.statusCode, 200);
    const chunkBody = parseJson(chunkRes);
    insertedChunkId = chunkBody.chunk?.id;
    assert.ok(insertedChunkId);

    const searchRes = await run(handler, makeRequest({
      method: "GET",
      url: "/v1/search?q=hello&limit=1&scope=all&app=DemoApp",
      headers: { host: "127.0.0.1", authorization: `Bearer ${token}` },
    }));
    assert.equal(searchRes.statusCode, 200);
    const searchBody = parseJson(searchRes);
    assert.ok(Array.isArray(searchBody.results));
    assert.ok(searchBody.results.length <= 1);
    assert.equal(searchBody.results[0]?.id, insertedChunkId);

    // 覆盖 parseLimit 分支：缺省/非法/上下界
    {
      const res1 = await run(handler, makeRequest({
        method: "GET",
        url: "/v1/search?q=hello",
        headers: { host: "127.0.0.1", authorization: `Bearer ${token}` },
      }));
      assert.equal(res1.statusCode, 200);

      const res2 = await run(handler, makeRequest({
        method: "GET",
        url: "/v1/search?q=hello&limit=bad",
        headers: { host: "127.0.0.1", authorization: `Bearer ${token}` },
      }));
      assert.equal(res2.statusCode, 200);

      const res3 = await run(handler, makeRequest({
        method: "GET",
        url: "/v1/search?q=hello&limit=999",
        headers: { host: "127.0.0.1", authorization: `Bearer ${token}` },
      }));
      assert.equal(res3.statusCode, 200);

      const res4 = await run(handler, makeRequest({
        method: "GET",
        url: "/v1/search?q=hello&limit=0",
        headers: { host: "127.0.0.1", authorization: `Bearer ${token}` },
      }));
      assert.equal(res4.statusCode, 200);
    }

    const getChunkRes = await run(handler, makeRequest({
      method: "GET",
      url: `/v1/chunks/${insertedChunkId}`,
      headers: { host: "127.0.0.1", authorization: `Bearer ${token}` },
    }));
    assert.equal(getChunkRes.statusCode, 200);
    const getChunkBody = parseJson(getChunkRes);
    assert.equal(getChunkBody.chunk?.id, insertedChunkId);
    assert.match(getChunkBody.chunk?.text ?? "", /agent handler test/);

    const missingRes = await run(handler, makeRequest({
      method: "GET",
      url: "/v1/chunks/not-exist",
      headers: { host: "127.0.0.1", authorization: `Bearer ${token}` },
    }));
    assert.equal(missingRes.statusCode, 404);
    const missingBody = parseJson(missingRes);
    assert.equal(missingBody.error, "Chunk not found");
  }

  // summaries/daily：不带 date 参数走默认值
  {
    const res = await run(handler, makeRequest({
      method: "GET",
      url: "/v1/summaries/daily",
      headers: { host: "127.0.0.1", authorization: `Bearer ${token}` },
    }));
    assert.equal(res.statusCode, 200);
    const body = parseJson(res);
    assert.ok("summary" in body);
  }

  // timeline/daily：不带 date 参数走默认值
  {
    const res = await run(handler, makeRequest({
      method: "GET",
      url: "/v1/timeline/daily",
      headers: { host: "127.0.0.1", authorization: `Bearer ${token}` },
    }));
    assert.equal(res.statusCode, 200);
    const body = parseJson(res);
    assert.ok(body.timeline);
    assert.ok(body.timeline.date);
  }

  // maintenance/media-stats
  {
    const res = await run(handler, makeRequest({
      method: "GET",
      url: "/v1/maintenance/media-stats?refresh=1",
      headers: { host: "127.0.0.1", authorization: `Bearer ${token}` },
    }));
    assert.equal(res.statusCode, 200);
    const body = parseJson(res);
    assert.ok(body.stats);
  }

  // maintenance/reclean-chunks
  {
    const res = await run(handler, makeRequest({
      method: "POST",
      url: "/v1/maintenance/reclean-chunks",
      headers: {
        host: "127.0.0.1",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ limit: 10, dryRun: true }),
    }));
    assert.equal(res.statusCode, 200);
    const body = parseJson(res);
    assert.ok(body.result);
    assert.ok(Number.isFinite(body.result.processed));
  }

  // maintenance/cleanup
  {
    // body 为空：retentionDays 走 fallback（settings）
    const resFallback = await run(handler, makeRequest({
      method: "POST",
      url: "/v1/maintenance/cleanup",
      headers: {
        host: "127.0.0.1",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    }));
    assert.equal(resFallback.statusCode, 200);

    const res = await run(handler, makeRequest({
      method: "POST",
      url: "/v1/maintenance/cleanup",
      headers: {
        host: "127.0.0.1",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ retentionDays: 7, maxFramesPerRun: 10 }),
    }));
    assert.equal(res.statusCode, 200);
    const body = parseJson(res);
    assert.ok(body.result);
  }

  // danger/delete (scope=all)
  {
    const res = await run(handler, makeRequest({
      method: "POST",
      url: "/v1/danger/delete",
      headers: {
        host: "127.0.0.1",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ scope: "all" }),
    }));
    assert.equal(res.statusCode, 200);
    const body = parseJson(res);
    assert.ok(body.media);
    assert.equal(body.media.ok, true);
  }

  // danger/delete (scope=lastHour)：会走 deleteEvidenceFiles 分支
  {
    const res = await run(handler, makeRequest({
      method: "POST",
      url: "/v1/danger/delete",
      headers: {
        host: "127.0.0.1",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ scope: "lastHour" }),
    }));
    assert.equal(res.statusCode, 200);
    const body = parseJson(res);
    assert.ok(body.files);
    assert.equal(body.media, undefined);
  }

  // danger/delete：scope 缺省 -> 默认 lastHour
  {
    const res = await run(handler, makeRequest({
      method: "POST",
      url: "/v1/danger/delete",
      headers: {
        host: "127.0.0.1",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    }));
    assert.equal(res.statusCode, 200);
    const body = parseJson(res);
    assert.ok(body.files);
  }

	  // backup/db：返回 sqlite 文件，且会清理 tmp/snapshots
	  {
	    const res = await run(handler, makeRequest({
	      method: "GET",
      url: "/v1/backup/db",
      headers: { host: "127.0.0.1", authorization: `Bearer ${token}` },
    }));
    assert.equal(res.statusCode, 200);
	    assert.match(String(res.headers["Content-Type"] ?? ""), /application\/x-sqlite3/);
	    assert.ok(res.body().length > 0);

	    const snapshotsDir = path.join(dataDir, "tmp", "snapshots");
	    // cleanup 是异步 unlink：这里做一个短暂轮询，避免测试对时序过于敏感。
	    const startedAt = Date.now();
	    let entries = await fs.readdir(snapshotsDir);
	    while (entries.length > 0 && Date.now() - startedAt < 3000) {
	      await new Promise((r) => setTimeout(r, 30));
	      entries = await fs.readdir(snapshotsDir);
	    }
	    assert.equal(entries.length, 0);
	  }

  // shutdown：不会退出进程，但会触发回调
  {
    const res = await run(handler, makeRequest({
      method: "POST",
      url: "/v1/maintenance/shutdown",
      headers: { host: "127.0.0.1", authorization: `Bearer ${token}` },
    }));
    assert.equal(res.statusCode, 202);
    const body = parseJson(res);
    assert.equal(body.ok, true);
    assert.equal(shutdownCalled, 1);
  }

  // shutdown：回调异常也应被吞掉
  {
    const handlerThrowingShutdown = createAgentRequestHandler({
      host: "127.0.0.1",
      serviceName: "recapsense-agent",
      dataDir,
      token,
      getStore: () => store,
      getDb: () => db,
      maintenance,
      onShutdown: () => {
        throw new Error("shutdown boom");
      },
    });

    const res = await run(handlerThrowingShutdown, makeRequest({
      method: "POST",
      url: "/v1/maintenance/shutdown",
      headers: { host: "127.0.0.1", authorization: `Bearer ${token}` },
    }));
    assert.equal(res.statusCode, 202);
    const body = parseJson(res);
    assert.equal(body.ok, true);
  }

  if (typeof db.close === "function") db.close();
});

test("agent handler: backup stream error should not crash request", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const token = "test-token";
  const handler = createAgentRequestHandler({
    host: "127.0.0.1",
    serviceName: "recapsense-agent",
    dataDir,
    token,
    getStore: () => store,
    getDb: () => db,
    createReadStream: () => {
      const stream = new Readable({ read() {} });
      queueMicrotask(() => stream.emit("error", new Error("stream boom")));
      return stream;
    },
    unlinkFile: () => {
      throw new Error("unlink boom");
    },
  });

  const res = await run(handler, makeRequest({
    method: "GET",
    url: "/v1/backup/db",
    headers: { host: "127.0.0.1", authorization: `Bearer ${token}` },
  }));

  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["Content-Type"] ?? ""), /application\/x-sqlite3/);

  if (typeof db.close === "function") db.close();
});

test("agent handler: stream error should swallow res.end exceptions", async () => {
  const dataDir = await makeTempDir();
  const { db, withTransaction } = await openDatabase(dataDir);
  const store = createStore(db, { withTransaction });

  const token = "test-token";
  const handler = createAgentRequestHandler({
    host: "127.0.0.1",
    serviceName: "recapsense-agent",
    dataDir,
    token,
    getStore: () => store,
    getDb: () => db,
    createReadStream: () => {
      const stream = new Readable({ read() {} });
      queueMicrotask(() => stream.emit("error", new Error("stream boom")));
      return stream;
    },
  });

  const req = makeRequest({
    method: "GET",
    url: "/v1/backup/db",
    headers: { host: "127.0.0.1", authorization: `Bearer ${token}` },
  });

  const res = new ThrowingEndResponse();
  const done = once(res, "finish");
  await handler(req, res);
  await done;

  assert.equal(res.statusCode, 200);

  if (typeof db.close === "function") db.close();
});

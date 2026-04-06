/**
 * PoC-02: 嵌入式模式崩溃恢复
 *
 * 通过标准: kill -9 后重启，数据无丢失
 * 失败预案: 评估 standalone server 模式
 *
 * 测试流程:
 *   1. 启动 standalone SurrealDB（文件持久化）
 *   2. 写入 100 条测试数据
 *   3. kill -9 强制终止
 *   4. 重启 SurrealDB
 *   5. 验证数据完整性
 *
 * 使用方式: bun run poc-02-crash-recovery.ts [phase]
 *   phase=write  — 步骤 1-2: 启动服务器 + 写入数据
 *   phase=verify — 步骤 4-5: 重启服务器 + 验证数据
 *   phase=all    — 自动执行全流程（包含 kill -9）
 */

import { Surreal, Table, StringRecordId } from "surrealdb";
import { $ } from "bun";

const DB_PORT = 21891; // 用不同端口避免冲突
const ENDPOINT = `ws://127.0.0.1:${DB_PORT}`;
const NS = "poc";
const DB = "test02";
const DATA_DIR = "/tmp/recaply-poc02-data";
const RECORD_COUNT = 100;

async function startServer(): Promise<number> {
  // 确保数据目录存在
  await $`mkdir -p ${DATA_DIR}`;

  // 启动 SurrealDB standalone（文件持久化）
  const proc = Bun.spawn(
    [
      "surreal",
      "start",
      "--bind",
      `127.0.0.1:${DB_PORT}`,
      "--user",
      "root",
      "--pass",
      "root",
      `surrealkv://${DATA_DIR}/poc02.db`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  console.log(`SurrealDB 启动中 (PID: ${proc.pid})...`);

  // 等待服务就绪
  for (let i = 0; i < 30; i++) {
    try {
      const resp = await fetch(`http://127.0.0.1:${DB_PORT}/health`);
      if (resp.ok) {
        console.log(`✅ SurrealDB 就绪 (PID: ${proc.pid})`);
        return proc.pid;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("SurrealDB 启动超时");
}

async function writeData(db: Surreal): Promise<string[]> {
  const ids: string[] = [];
  console.log(`写入 ${RECORD_COUNT} 条测试数据...`);

  for (let i = 0; i < RECORD_COUNT; i++) {
    const result = await db
      .create(new StringRecordId(`test_record:rec_${i.toString().padStart(4, "0")}`))
      .content({
        index: i,
        text: `测试数据 #${i} — 这是一段用于崩溃恢复验证的文本`,
        timestamp: new Date().toISOString(),
        checksum: `hash_${i}_${Date.now()}`,
      });

    const id = (result as any)?.id;
    if (id) ids.push(String(id));

    if ((i + 1) % 25 === 0) {
      console.log(`  已写入 ${i + 1}/${RECORD_COUNT}`);
    }
  }

  console.log(`✅ 已写入 ${ids.length} 条数据`);
  return ids;
}

async function verifyData(db: Surreal): Promise<boolean> {
  console.log("验证数据完整性...");

  const result = await db.query<[Array<{ index: number }>]>(
    "SELECT * FROM test_record ORDER BY index",
  );
  const records = result[0];

  if (!Array.isArray(records)) {
    console.error("FAIL: 查询结果不是数组");
    return false;
  }

  console.log(`  查询到 ${records.length} 条记录（预期 ${RECORD_COUNT}）`);

  if (records.length !== RECORD_COUNT) {
    console.error(
      `FAIL: 数据丢失 — 预期 ${RECORD_COUNT} 条，实际 ${records.length} 条`,
    );
    return false;
  }

  // 验证数据连续性
  for (let i = 0; i < records.length; i++) {
    if (records[i].index !== i) {
      console.error(`FAIL: 数据不连续 — 第 ${i} 条记录 index = ${records[i].index}`);
      return false;
    }
  }

  console.log("✅ 数据完整性验证通过");
  return true;
}

async function connectDb(): Promise<Surreal> {
  const db = new Surreal();
  await db.connect(ENDPOINT);
  await db.signin({ username: "root", password: "root" });
  await db.use({ namespace: NS, database: DB });
  return db;
}

async function runAll() {
  console.log("=== PoC-02: 崩溃恢复测试（全自动流程）===\n");

  // 清理旧数据
  await $`rm -rf ${DATA_DIR}`;

  // Step 1: 启动服务器 + 写入数据
  console.log("--- Step 1: 启动服务器 + 写入数据 ---");
  const pid = await startServer();

  let db = await connectDb();
  const ids = await writeData(db);
  await db.close();

  // Step 2: kill -9 强制终止
  console.log(`\n--- Step 2: kill -9 PID=${pid} ---`);
  process.kill(pid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 1000));

  // 确认进程已终止
  try {
    process.kill(pid, 0);
    console.error("FAIL: 进程未被终止");
    return;
  } catch {
    console.log("✅ 进程已被 SIGKILL 终止");
  }

  // Step 3: 重启服务器
  console.log("\n--- Step 3: 重启服务器 ---");
  const newPid = await startServer();

  // Step 4: 验证数据
  console.log("\n--- Step 4: 验证数据 ---");
  db = await connectDb();
  const pass = await verifyData(db);
  await db.close();

  // 清理
  process.kill(newPid, "SIGTERM");
  await new Promise((r) => setTimeout(r, 500));

  console.log(`\n=== PoC-02 结果: ${pass ? "✅ PASS" : "❌ FAIL"} ===`);
  if (!pass) {
    console.log("失败预案: 评估 standalone server 模式，增加 WAL 日志防护");
  }

  // 清理数据目录
  await $`rm -rf ${DATA_DIR}`;
}

runAll().catch((err) => {
  console.error("PoC-02 异常:", err);
  process.exit(1);
});

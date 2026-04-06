/**
 * PoC-03: 10 万条向量搜索
 *
 * 通过标准: HNSW 搜索延迟 < 200ms (P95)
 * 失败预案: 评估降维策略
 *
 * 测试流程:
 *   1. 创建 HNSW 向量索引
 *   2. 批量插入 100,000 条带向量数据（1024 维，模拟 BGE-M3）
 *   3. 执行 100 次随机向量搜索
 *   4. 统计延迟分布（P50、P95、P99）
 */

import { Surreal, Table } from "surrealdb";

const ENDPOINT = "ws://127.0.0.1:21890"; // 使用已运行的 SurrealDB
const NS = "poc";
const DB = "test03";

const VECTOR_DIM = 1024; // BGE-M3 维度
const TOTAL_RECORDS = 100_000;
const BATCH_SIZE = 500; // 每批 500 条
const SEARCH_ROUNDS = 100;
const TOP_K = 10;

function randomVector(dim: number): number[] {
  const vec = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    vec[i] = Math.random() * 2 - 1;
  }
  // 归一化
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  const result: number[] = new Array(dim);
  for (let i = 0; i < dim; i++) result[i] = vec[i] / norm;
  return result;
}

async function setupSchema(db: Surreal) {
  console.log("创建 Schema + HNSW 索引...");
  await db.query(`
    DEFINE TABLE IF NOT EXISTS vec_doc SCHEMAFULL;
    DEFINE FIELD IF NOT EXISTS content ON vec_doc TYPE string;
    DEFINE FIELD IF NOT EXISTS embedding ON vec_doc TYPE array<float>;
    DEFINE FIELD IF NOT EXISTS embedding.* ON vec_doc TYPE float;
    DEFINE INDEX IF NOT EXISTS idx_vec_hnsw ON vec_doc FIELDS embedding
      HNSW DIMENSION ${VECTOR_DIM}
      DIST COSINE
      TYPE F32
      EFC 150
      M 12;
  `);
  console.log("✅ Schema 创建完成");
}

async function insertData(db: Surreal) {
  console.log(`\n插入 ${TOTAL_RECORDS.toLocaleString()} 条数据（${VECTOR_DIM} 维向量）...`);
  const startTime = Date.now();
  let inserted = 0;

  for (let batch = 0; batch < TOTAL_RECORDS / BATCH_SIZE; batch++) {
    // 构造批量 INSERT 语句
    const values: string[] = [];
    for (let i = 0; i < BATCH_SIZE; i++) {
      const idx = batch * BATCH_SIZE + i;
      const vec = randomVector(VECTOR_DIM);
      values.push(
        `{ content: '文档 ${idx}', embedding: [${vec.join(",")}] }`,
      );
    }

    await db.query(
      `INSERT INTO vec_doc [${values.join(",")}]`,
    );

    inserted += BATCH_SIZE;
    if (inserted % 10_000 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = (inserted / ((Date.now() - startTime) / 1000)).toFixed(0);
      console.log(
        `  ${inserted.toLocaleString()} / ${TOTAL_RECORDS.toLocaleString()} (${elapsed}s, ${rate} rec/s)`,
      );
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `✅ 插入完成: ${inserted.toLocaleString()} 条, 耗时 ${totalTime}s`,
  );
}

async function runSearchBenchmark(db: Surreal) {
  console.log(`\n执行 ${SEARCH_ROUNDS} 次向量搜索 (TOP ${TOP_K})...`);

  const latencies: number[] = [];

  for (let i = 0; i < SEARCH_ROUNDS; i++) {
    const queryVec = randomVector(VECTOR_DIM);

    const start = performance.now();
    const result = await db.query(
      `SELECT id, content
       FROM vec_doc
       WHERE embedding <|${TOP_K}|> $vec`,
      { vec: queryVec },
    );
    const elapsed = performance.now() - start;
    latencies.push(elapsed);

    if (i === 0) {
      // 打印第一次结果示例
      const hits = (result as any)[0];
      console.log(
        `  第一次搜索示例: ${hits?.length ?? 0} 条结果, 耗时 ${elapsed.toFixed(1)}ms`,
      );
    }
  }

  // 统计
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(SEARCH_ROUNDS * 0.5)];
  const p95 = latencies[Math.floor(SEARCH_ROUNDS * 0.95)];
  const p99 = latencies[Math.floor(SEARCH_ROUNDS * 0.99)];
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const min = latencies[0];
  const max = latencies[latencies.length - 1];

  console.log("\n=== 搜索延迟统计 ===");
  console.log(`  Min:  ${min.toFixed(2)}ms`);
  console.log(`  Avg:  ${avg.toFixed(2)}ms`);
  console.log(`  P50:  ${p50.toFixed(2)}ms`);
  console.log(`  P95:  ${p95.toFixed(2)}ms  ${p95 < 200 ? "✅ < 200ms" : "❌ >= 200ms"}`);
  console.log(`  P99:  ${p99.toFixed(2)}ms`);
  console.log(`  Max:  ${max.toFixed(2)}ms`);

  return { p50, p95, p99, avg, min, max };
}

async function main() {
  console.log("=== PoC-03: 10 万条向量搜索性能测试 ===");
  console.log(`维度: ${VECTOR_DIM}, 数据量: ${TOTAL_RECORDS.toLocaleString()}`);
  console.log(`Endpoint: ${ENDPOINT}\n`);

  const db = new Surreal();

  try {
    await db.connect(ENDPOINT);
    await db.signin({ username: "root", password: "root" });
    await db.use({ namespace: NS, database: DB });

    await setupSchema(db);
    await insertData(db);

    // 等待索引构建
    console.log("\n等待 HNSW 索引构建...");
    await new Promise((r) => setTimeout(r, 3000));

    const stats = await runSearchBenchmark(db);

    // 清理
    await db.query("REMOVE TABLE vec_doc");

    console.log(`\n=== PoC-03 结果: ${stats.p95 < 200 ? "✅ PASS" : "❌ FAIL"} ===`);
    console.log(`P95 延迟 ${stats.p95.toFixed(2)}ms ${stats.p95 < 200 ? "<" : ">="} 200ms 阈值`);

    if (stats.p95 >= 200) {
      console.log("失败预案: 考虑降维策略（1024 → 512/256），或调整 HNSW 参数");
    }
  } catch (err) {
    console.error("PoC-03 异常:", err);
    process.exit(1);
  } finally {
    await db.close();
  }
}

main();

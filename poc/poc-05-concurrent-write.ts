/**
 * PoC-05: HNSW 并发写入
 * 通过标准: ingestion 写入 + search 查询并发无死锁
 * 失败预案: 引入读写队列化
 */
import { Surreal, Table, StringRecordId } from "surrealdb";

const ENDPOINT = "ws://127.0.0.1:21890";
const NS = "poc";
const DB = "test05";
const DIM = 128; // 用较小维度加速测试
const WRITE_COUNT = 1000;
const SEARCH_COUNT = 100;
const CONCURRENCY = 5;

function randomVec(dim: number): number[] {
  const v = new Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.random() * 2 - 1;
  return v;
}

async function createConnection(): Promise<Surreal> {
  const db = new Surreal();
  await db.connect(ENDPOINT);
  await db.signin({ username: "root", password: "root" });
  await db.use({ namespace: NS, database: DB });
  return db;
}

async function main() {
  console.log("=== PoC-05: HNSW 并发写入测试 ===\n");

  const db = await createConnection();

  // Schema
  await db.query(`
    DEFINE TABLE IF NOT EXISTS conc_doc SCHEMAFULL;
    DEFINE FIELD IF NOT EXISTS text ON conc_doc TYPE string;
    DEFINE FIELD IF NOT EXISTS embedding ON conc_doc TYPE array<float>;
    DEFINE FIELD IF NOT EXISTS embedding.* ON conc_doc TYPE float;
    DEFINE INDEX IF NOT EXISTS idx ON conc_doc FIELDS embedding HNSW DIMENSION ${DIM} DIST COSINE TYPE F32 EFC 100 M 12;
  `);

  // 先插入一些基础数据
  console.log("插入 500 条基础数据...");
  for (let i = 0; i < 500; i++) {
    await db.create(new StringRecordId(`conc_doc:base_${i}`)).content({
      text: `基础文档 ${i}`,
      embedding: randomVec(DIM),
    });
  }
  console.log("✅ 基础数据就绪");

  // 并发写入 + 读取
  console.log(`\n并发测试: ${CONCURRENCY} 个写入者 × ${WRITE_COUNT / CONCURRENCY} 条 + ${SEARCH_COUNT} 次搜索...`);

  let writeErrors = 0;
  let searchErrors = 0;
  let deadlocks = 0;
  const writeStart = performance.now();

  // 写入任务
  const writers = Array.from({ length: CONCURRENCY }, async (_, wid) => {
    const conn = await createConnection();
    const perWriter = WRITE_COUNT / CONCURRENCY;
    for (let i = 0; i < perWriter; i++) {
      try {
        await conn.create(new StringRecordId(`conc_doc:w${wid}_${i}`)).content({
          text: `并发文档 w${wid}_${i}`,
          embedding: randomVec(DIM),
        });
      } catch (e: any) {
        writeErrors++;
        if (String(e).includes("deadlock")) deadlocks++;
      }
    }
    await conn.close();
  });

  // 搜索任务（同时进行）
  const searchers = Array.from({ length: 2 }, async () => {
    const conn = await createConnection();
    for (let i = 0; i < SEARCH_COUNT / 2; i++) {
      try {
        await conn.query(
          `SELECT id FROM conc_doc WHERE embedding <|5,50|> $vec`,
          { vec: randomVec(DIM) },
        );
      } catch (e: any) {
        searchErrors++;
        if (String(e).includes("deadlock")) deadlocks++;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    await conn.close();
  });

  await Promise.all([...writers, ...searchers]);
  const elapsed = ((performance.now() - writeStart) / 1000).toFixed(1);

  // 验证
  const count = await db.query("SELECT count() FROM conc_doc GROUP ALL");
  const totalRecords = (count as any)[0]?.[0]?.count ?? 0;

  console.log(`\n=== PoC-05 结果 ===`);
  console.log(`  耗时: ${elapsed}s`);
  console.log(`  总记录: ${totalRecords} (预期 ~${500 + WRITE_COUNT})`);
  console.log(`  写入错误: ${writeErrors}`);
  console.log(`  搜索错误: ${searchErrors}`);
  console.log(`  死锁: ${deadlocks}`);

  const pass = deadlocks === 0 && writeErrors < WRITE_COUNT * 0.01;
  console.log(`\n结果: ${pass ? "✅ PASS" : "❌ FAIL"}`);

  await db.query("REMOVE TABLE conc_doc");
  await db.close();
}

main().catch(console.error);

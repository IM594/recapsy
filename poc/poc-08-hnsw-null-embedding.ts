/**
 * PoC-08: HNSW + option embedding 行为
 * 通过标准: embedding 为 null 时 HNSW 索引自动跳过该记录
 * 失败预案: 搜索查询中强制加 WHERE embedding IS NOT NULL
 */
import { Surreal, Table, StringRecordId } from "surrealdb";

const ENDPOINT = "ws://127.0.0.1:21890";
const NS = "poc";
const DB = "test08";
const DIM = 64;

function randomVec(dim: number): number[] {
  const v = new Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.random() * 2 - 1;
  return v;
}

async function main() {
  console.log("=== PoC-08: HNSW + null embedding 行为测试 ===\n");

  const db = new Surreal();
  await db.connect(ENDPOINT);
  await db.signin({ username: "root", password: "root" });
  await db.use({ namespace: NS, database: DB });

  // Schema: embedding 是 option 类型
  await db.query(`
    DEFINE TABLE IF NOT EXISTS opt_doc SCHEMAFULL;
    DEFINE FIELD IF NOT EXISTS text ON opt_doc TYPE string;
    DEFINE FIELD IF NOT EXISTS embedding ON opt_doc TYPE option<array<float>>;
    DEFINE FIELD IF NOT EXISTS embedding.* ON opt_doc TYPE float;
    DEFINE INDEX IF NOT EXISTS idx ON opt_doc FIELDS embedding HNSW DIMENSION ${DIM} DIST COSINE TYPE F32 EFC 100 M 12;
  `);

  // 插入有 embedding 的记录
  for (let i = 0; i < 10; i++) {
    await db.create(new StringRecordId(`opt_doc:with_${i}`)).content({
      text: `有向量的文档 ${i}`,
      embedding: randomVec(DIM),
    });
  }

  // 插入无 embedding 的记录
  for (let i = 0; i < 5; i++) {
    await db.create(new StringRecordId(`opt_doc:without_${i}`)).content({
      text: `无向量的文档 ${i}`,
    });
  }

  // 也试试显式设为 NONE/null
  await db.query(`CREATE opt_doc:null_vec SET text = '显式null', embedding = NONE`);

  const total = await db.query("SELECT count() FROM opt_doc GROUP ALL");
  console.log(`总记录数: ${(total as any)[0]?.[0]?.count}`);

  // Test 1: KNN 搜索是否正常（不崩溃）
  console.log("\n--- Test 1: KNN 搜索是否正常 ---");
  try {
    const r = await db.query(
      `SELECT id, text FROM opt_doc WHERE embedding <|5,50|> $vec`,
      { vec: randomVec(DIM) },
    );
    const hits = (r as any)[0] ?? [];
    console.log(`  KNN 搜索返回 ${hits.length} 条结果`);
    console.log(`  ✅ KNN 搜索未崩溃`);

    // 检查结果中是否包含无向量的记录
    const hasNull = hits.some((h: any) => String(h.id).includes("without") || String(h.id).includes("null_vec"));
    console.log(`  结果中包含无向量记录: ${hasNull ? "是 ⚠️" : "否 ✅"}`);
  } catch (e) {
    console.log(`  ❌ KNN 搜索失败: ${e}`);
  }

  // Test 2: 加 IS NOT NONE 谓词
  console.log("\n--- Test 2: 加 embedding IS NOT NONE 谓词 ---");
  try {
    const r = await db.query(
      `SELECT id, text FROM opt_doc WHERE embedding IS NOT NONE AND embedding <|5,50|> $vec`,
      { vec: randomVec(DIM) },
    );
    const hits = (r as any)[0] ?? [];
    console.log(`  返回 ${hits.length} 条结果`);
    const hasNull = hits.some((h: any) => String(h.id).includes("without") || String(h.id).includes("null_vec"));
    console.log(`  包含无向量记录: ${hasNull ? "是 ⚠️" : "否 ✅"}`);
  } catch (e) {
    console.log(`  ❌ 带谓词搜索失败: ${e}`);
    // 尝试反过来
    try {
      const r2 = await db.query(
        `SELECT id, text FROM opt_doc WHERE embedding <|5,50|> $vec AND embedding IS NOT NONE`,
        { vec: randomVec(DIM) },
      );
      console.log(`  反转谓词顺序: 返回 ${(r2 as any)[0]?.length} 条结果`);
    } catch (e2) {
      console.log(`  反转顺序也失败: ${e2}`);
    }
  }

  // Test 3: 暴力搜索 + IS NOT NONE
  console.log("\n--- Test 3: 暴力搜索 + IS NOT NONE ---");
  try {
    const r = await db.query(
      `SELECT id, text, vector::similarity::cosine(embedding, $vec) AS score
       FROM opt_doc WHERE embedding IS NOT NONE ORDER BY score DESC LIMIT 5`,
      { vec: randomVec(DIM) },
    );
    const hits = (r as any)[0] ?? [];
    console.log(`  返回 ${hits.length} 条结果（应全部有向量）`);
    console.log(`  ✅ 暴力搜索 + IS NOT NONE 正常`);
  } catch (e) {
    console.log(`  ❌ 失败: ${e}`);
  }

  console.log("\n=== PoC-08 结果汇总 ===");
  console.log("结论: 需要在实际搜索时验证 null embedding 的处理方式");

  await db.query("REMOVE TABLE opt_doc");
  await db.close();
}

main().catch(console.error);

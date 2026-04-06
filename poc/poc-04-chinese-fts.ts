/**
 * PoC-04: 中文预分词全文搜索
 *
 * 通过标准: jieba 分词 + blank tokenizer 召回率可接受
 * 失败预案: 加重向量搜索权重，FTS 降级为辅助
 *
 * 测试流程:
 *   1. 用 jieba-wasm 对中文文本分词
 *   2. 将分词结果用空格连接存入 SurrealDB
 *   3. 创建 blank tokenizer 全文索引
 *   4. 测试搜索召回率
 */

import { Surreal, Table, StringRecordId } from "surrealdb";
// @ts-ignore
import * as jieba from "jieba-wasm";

const ENDPOINT = "ws://127.0.0.1:21890";
const NS = "poc";
const DB = "test04";

// 测试数据：模拟 OCR 提取的屏幕文本
const testDocs = [
  { id: "doc_01", text: "在 VS Code 中编写 TypeScript 代码，使用 Bun 运行测试" },
  { id: "doc_02", text: "微信聊天记录：明天下午三点开会讨论项目进度" },
  { id: "doc_03", text: "Chrome 浏览器打开了 SurrealDB 官方文档页面" },
  { id: "doc_04", text: "Figma 设计稿：首页导航栏和搜索框组件" },
  { id: "doc_05", text: "终端执行 git commit 提交代码到 GitHub 仓库" },
  { id: "doc_06", text: "钉钉消息：张三发来了产品需求文档的链接" },
  { id: "doc_07", text: "Safari 浏览器查看 Apple Developer 开发者文档" },
  { id: "doc_08", text: "Xcode 编译 SwiftUI 项目，显示构建成功" },
  { id: "doc_09", text: "飞书文档：2024年第四季度 OKR 回顾和总结" },
  { id: "doc_10", text: "VS Code 调试 Python 爬虫脚本，设置断点" },
  { id: "doc_11", text: "浏览器访问淘宝购物车，准备双十一抢购清单" },
  { id: "doc_12", text: "Slack 频道讨论 API 接口设计方案和版本管理" },
  { id: "doc_13", text: "终端使用 Docker 运行 PostgreSQL 数据库容器" },
  { id: "doc_14", text: "Notion 笔记：机器学习算法学习笔记和代码示例" },
  { id: "doc_15", text: "微信视频通话与客户讨论项目交付时间表" },
];

// 搜索测试用例：query → 期望命中的 doc IDs
const searchTests = [
  { query: "TypeScript", expected: ["doc_01"] },
  { query: "开会", expected: ["doc_02"] },
  { query: "SurrealDB", expected: ["doc_03"] },
  { query: "设计", expected: ["doc_04", "doc_12"] },
  { query: "git", expected: ["doc_05"] },
  { query: "文档", expected: ["doc_06", "doc_07", "doc_09", "doc_14"] },
  { query: "SwiftUI", expected: ["doc_08"] },
  { query: "浏览器", expected: ["doc_03", "doc_07", "doc_11"] },
  { query: "代码", expected: ["doc_01", "doc_05", "doc_14"] },
  { query: "API 接口", expected: ["doc_12"] },
  { query: "数据库", expected: ["doc_13"] },
  { query: "项目进度", expected: ["doc_02"] },
];

function tokenize(text: string): string {
  // jieba 分词，返回空格连接的 token 列表
  const words: string[] = jieba.cut(text, false);
  // 过滤掉纯空白 token
  return words.filter((w: string) => w.trim().length > 0).join(" ");
}

async function main() {
  console.log("=== PoC-04: 中文预分词全文搜索测试 ===\n");

  // 1. 测试 jieba-wasm 分词
  console.log("--- Step 1: jieba-wasm 分词测试 ---");
  const initStart = performance.now();

  // jieba-wasm 初始化（可能需要加载字典）
  if (typeof jieba.loadDict === "function") {
    console.log("加载 jieba 字典...");
  }

  const initTime = performance.now() - initStart;
  console.log(`jieba 初始化耗时: ${initTime.toFixed(1)}ms`);

  // 分词示例
  for (const doc of testDocs.slice(0, 3)) {
    const tokenized = tokenize(doc.text);
    console.log(`  原文: ${doc.text}`);
    console.log(`  分词: ${tokenized}\n`);
  }

  // 2. 连接 SurrealDB 并创建 Schema
  console.log("--- Step 2: 创建 Schema + 全文索引 ---");
  const db = new Surreal();
  await db.connect(ENDPOINT);
  await db.signin({ username: "root", password: "root" });
  await db.use({ namespace: NS, database: DB });

  await db.query(`
    DEFINE TABLE IF NOT EXISTS fts_doc SCHEMAFULL;
    DEFINE FIELD IF NOT EXISTS original_text ON fts_doc TYPE string;
    DEFINE FIELD IF NOT EXISTS tokenized_text ON fts_doc TYPE string;
    DEFINE ANALYZER IF NOT EXISTS blank_az TOKENIZERS blank;
    DEFINE INDEX IF NOT EXISTS idx_fts ON fts_doc FIELDS tokenized_text
      FULLTEXT ANALYZER blank_az;
  `);
  console.log("✅ Schema + 全文索引创建完成");

  // 3. 插入分词后的数据
  console.log("\n--- Step 3: 插入测试数据 ---");
  for (const doc of testDocs) {
    const tokenized = tokenize(doc.text);
    await db
      .create(new StringRecordId(`fts_doc:${doc.id}`))
      .content({
        original_text: doc.text,
        tokenized_text: tokenized,
      });
  }
  console.log(`✅ 已插入 ${testDocs.length} 条文档`);

  // 4. 搜索测试
  console.log("\n--- Step 4: 搜索召回率测试 ---");
  let totalTests = 0;
  let passedTests = 0;
  let totalRecall = 0;

  for (const test of searchTests) {
    totalTests++;
    const queryTokenized = tokenize(test.query);

    const result = await db.query<[Array<{ id: any; original_text: string }>]>(
      `SELECT id, original_text FROM fts_doc
       WHERE tokenized_text @@ $query`,
      { query: queryTokenized },
    );

    const hits = result[0] ?? [];
    const hitIds = hits.map((h) => {
      const idStr = String(h.id);
      // 提取 fts_doc:doc_xx 中的 doc_xx 部分
      const match = idStr.match(/fts_doc:(\w+)/);
      return match ? match[1] : idStr;
    });

    const recall =
      test.expected.length > 0
        ? test.expected.filter((e) => hitIds.includes(e)).length /
          test.expected.length
        : hitIds.length === 0
          ? 1
          : 0;
    totalRecall += recall;

    const pass = recall >= 0.5; // 至少召回一半
    if (pass) passedTests++;

    const status = recall === 1 ? "✅" : recall >= 0.5 ? "⚠️" : "❌";
    console.log(
      `  ${status} "${test.query}" → 分词: "${queryTokenized}" → 命中: [${hitIds.join(", ")}] (预期: [${test.expected.join(", ")}]) 召回率: ${(recall * 100).toFixed(0)}%`,
    );
  }

  const avgRecall = totalRecall / totalTests;
  console.log(`\n=== PoC-04 搜索结果汇总 ===`);
  console.log(`  测试用例: ${totalTests}`);
  console.log(`  通过 (>=50%召回): ${passedTests}/${totalTests}`);
  console.log(`  平均召回率: ${(avgRecall * 100).toFixed(1)}%`);

  const pass = avgRecall >= 0.5 && passedTests >= totalTests * 0.7;
  console.log(`\n结果: ${pass ? "✅ PASS" : "❌ FAIL"}`);
  if (!pass) {
    console.log(
      "失败预案: 加重向量搜索权重，FTS 仅作为辅助通道",
    );
  }

  // 清理
  await db.query("REMOVE TABLE fts_doc");
  await db.close();
}

main().catch((err) => {
  console.error("PoC-04 异常:", err);
  process.exit(1);
});

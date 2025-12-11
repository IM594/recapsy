import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import path from "path";

// 创建 SQLite Checkpointer
export function createCheckpointer() {
  const dbPath = path.join(process.cwd(), "checkpoints.db");

  // 从连接字符串创建 Checkpointer
  const checkpointer = SqliteSaver.fromConnString(dbPath);

  console.log(`✅ Checkpointer initialized at: ${dbPath}`);

  return checkpointer;
}

// 生成唯一的 thread_id
export function generateThreadId(date?: Date): string {
  const d = date || new Date();
  const dateStr = d.toISOString().split("T")[0]; // 2024-12-10
  // 添加随机后缀以支持同一天的多次执行
  const randomSuffix = Math.random().toString(36).substring(2, 7);
  return `daily-summary-${dateStr}-${randomSuffix}`;
}

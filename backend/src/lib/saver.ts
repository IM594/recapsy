/**
 * LangGraph Checkpointer - Native SqliteSaver integration
 * Handles workflow state persistence and resume capability
 */

import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import crypto from "crypto";

// Singleton instance
let checkpointerInstance: SqliteSaver | null = null;

/**
 * Get the singleton SqliteSaver instance
 * Uses SQLite for persistent workflow state management
 */
export async function getCheckpointer(): Promise<SqliteSaver> {
  if (!checkpointerInstance) {
    // SqliteSaver.fromConnString handles setup internally
    checkpointerInstance = SqliteSaver.fromConnString("./checkpoints.db");
  }
  return checkpointerInstance;
}

/**
 * Generate a unique thread ID for a workflow execution
 * Thread IDs enable resume capability - same thread_id = continue existing run
 */
export function generateThreadId(
  taskType: string,
  year: number,
  repos: string[]
): string {
  // Create a deterministic ID based on task parameters for resumability
  const repoHash = repos.sort().join(",");
  return `${taskType}-${year}-${Buffer.from(repoHash)
    .toString("base64")
    .slice(0, 8)}`;
}

/**
 * Generate a fresh thread ID for a new run (no resume)
 */
export function generateNewThreadId(): string {
  return crypto.randomUUID();
}

/**
 * Create thread configuration for workflow execution
 */
export function createThreadConfig(threadId: string) {
  return {
    configurable: {
      thread_id: threadId,
    },
  };
}

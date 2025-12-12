import { WorkflowState } from "../state";
import { progressTracker } from "../../lib/progress-tracker";
import { END } from "@langchain/langgraph";

/**
 * DataBarrier Node
 * Acts as a synchronization point for parallel collectors.
 */
export async function dataBarrier(state: WorkflowState) {
  const threadId = state.threadId || "unknown";

  // Define expected collectors
  // We always expect these three standard ones
  const expectedCollectors = ["git_collector", "user_input", "external_api"];

  // If in deep analysis, we also expect diff_collector
  // BUT diff_collector is started in parallel.
  // Note: collectGitDiffs should add "diff_collector" to progress even if it returns empty.
  if (state.deepAnalysis) {
    expectedCollectors.push("diff_collector");
  }

  const completed = state.collectorProgress || [];
  const allReady = expectedCollectors.every((c) => completed.includes(c));

  console.log(
    `[DataBarrier] Checking progress... Completed: [${completed.join(
      ", "
    )}], Expected: [${expectedCollectors.join(", ")}]`
  );

  if (!allReady) {
    return {};
  }

  console.log(
    `[DataBarrier] All collectors ready. Deep Analysis: ${state.deepAnalysis}`
  );

  // All Ready!

  // All Ready!
  progressTracker.updateProgress(threadId, {
    step: "dataBarrier",
    status: "completed", // Or just log it
    message: "所有数据收集完成，开始分析...",
    timestamp: Date.now(),
  });

  return {};
}

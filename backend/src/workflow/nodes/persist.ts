/**
 * Persist Node - Save all generated data to checkpoint
 */

import { WorkflowState } from "../state";
import { CheckpointManager } from "../../lib/checkpoint";
import logger from "../../lib/logger";

/**
 * LangGraph node: Persist all generated summaries to disk
 */
export async function persistNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  const {
    year,
    selectedRepos,
    authorPattern,
    dailySummaries,
    monthlySummaries,
    result,
  } = state;

  logger.step("💾", "Persist - Saving data to disk", {
    dailies: (dailySummaries || []).length,
    monthlies: (monthlySummaries || []).length,
  });

  const checkpoint = CheckpointManager.getInstance(year);
  await checkpoint.initialize(selectedRepos || [], authorPattern || "");

  // Save all daily summaries
  for (const daily of dailySummaries || []) {
    await checkpoint.saveDailySummary(daily);
  }

  // Save all monthly summaries
  for (const monthly of monthlySummaries || []) {
    await checkpoint.saveMonthlySummary(monthly);
  }

  // Save yearly summary if exists
  if (result?.type === "yearly" && result?.content) {
    await checkpoint.saveYearEndSummary(result.content);
  }

  await checkpoint.markComplete(result);

  logger.stepDone("All data persisted", 0);

  return {
    status: "complete",
    progress: 100,
  };
}

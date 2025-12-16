/**
 * Collect Data Node - Fetch commits from git repos
 */

import { WorkflowState } from "../state";
import { getCommitsByDay } from "../../lib/git";
import { CheckpointManager } from "../../lib/checkpoint";
import logger from "../../lib/logger";

/**
 * LangGraph node: Collect git commits from all repos
 */
export async function collectDataNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  const { selectedRepos, authorPattern, since, until, year } = state;

  logger.step("📦", "Collect Data - Fetching git commits", {
    repos: (selectedRepos || []).length,
    range: `${since} → ${until}`,
  });

  const data = await getCommitsByDay(
    selectedRepos || [],
    authorPattern || "",
    since,
    until,
    {
      includeDiffs: true,
      maxDiffLinesPerFile: 100,
    }
  );

  // Save to checkpoint
  const checkpoint = CheckpointManager.getInstance(year);
  await checkpoint.initialize(selectedRepos || [], authorPattern || "");

  for (const day of data) {
    await checkpoint.saveRawData(day.date, day.repo, day);
  }

  await checkpoint.updateProgress(
    "collect_data",
    20,
    `Collected ${data.length} date-repo entries`
  );

  logger.stepDone(`Collected ${data.length} date-repo entries`, 0);

  return {
    rawCommits: data,
    currentStep: "collect_data",
    progress: 20,
  };
}

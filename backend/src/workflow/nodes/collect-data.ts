/**
 * Collect Data Node - Fetch commits from git repos
 *
 * Pure function: Only modifies state, no side effects (SSE events)
 */

import { WorkflowState } from "../state";
import { getCommitsByDay } from "../../lib/git";
import { SummaryStore } from "../../lib/summary-store";
import { WorkflowRunner } from "../../lib/workflow-runner";
import logger from "../../lib/logger";
import { WORKFLOW_STEP_IDS } from "@recaply/shared";

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

  const runner = WorkflowRunner.getInstance(year);

  const data = await getCommitsByDay(
    selectedRepos || [],
    authorPattern || "",
    since,
    until,
    {
      includeDiffs: true,
      maxDiffLinesPerFile: 100,
      onProgress: (repoName, current, total) => {
        runner.updateProgress(
          WORKFLOW_STEP_IDS.collectData,
          Math.floor(((current + 1) / total) * 100),
          `Scanning ${repoName} (${current + 1}/${total})...`
        );
      },
    }
  );

  // Save to checkpoint for data persistence (not SSE)
  const checkpoint = SummaryStore.getInstance(year);
  await checkpoint.initialize(selectedRepos || [], authorPattern || "");

  for (const day of data) {
    await checkpoint.saveRawData(day.date, day.repo, day);
  }

  logger.stepDone(`Collected ${data.length} date-repo entries`, 0);

  // Mark collect phase as 100% complete
  runner.updateProgress(
    WORKFLOW_STEP_IDS.collectData,
    100,
    `Completed: ${data.length} entries`
  );

  // Pure state update
  return {
    rawCommits: data,
    currentStep: WORKFLOW_STEP_IDS.collectData,
  };
}

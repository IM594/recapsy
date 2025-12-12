import path from "path";
import { WorkflowState } from "../state";
import { ConfigManager } from "../../lib/config-manager";
import { progressTracker } from "../../lib/progress-tracker";
import { getRepoDiffs, GitDiff } from "../../lib/git";

/**
 * Git Diff Collector
 */
export async function collectGitDiffs(state: WorkflowState) {
  const threadId = state.threadId || "unknown";

  // Check if deep analysis is enabled
  if (!state.deepAnalysis) {
    return { gitDiffs: null, collectorProgress: ["diff_collector"] };
  }

  progressTracker.updateProgress(threadId, {
    step: "collectGitDiffs",
    status: "running",
    message: "正在获取代码 Diff...",
    timestamp: Date.now(),
  });

  const configManager = ConfigManager.getInstance();
  const config = configManager.getActiveProfile();

  try {
    const repos = state.selectedRepos || [];
    const authorPattern = config.git.authorPattern || "";
    const since = state.since || config.git.since || "yesterday";
    const until = state.until || "";

    if (repos.length === 0) {
      return { gitDiffs: [] };
    }

    const diffPromises = repos.map(async (repoPath) => {
      console.log(`[Diff Collector] Reading repo: ${repoPath}`);
      return await getRepoDiffs(repoPath, authorPattern, since, until);
    });

    const results = await Promise.all(diffPromises);
    // Flatten results: result is GitDiff[][]
    const allDiffs: GitDiff[] = results.flat();

    progressTracker.updateProgress(threadId, {
      step: "collectGitDiffs",
      status: "completed",
      message: `已获取 ${allDiffs.length} 个文件的变更详情`,
      timestamp: Date.now(),
    });

    return {
      gitDiffs: allDiffs,
      collectorProgress: ["diff_collector"],
    };
  } catch (error) {
    console.error("Diff collection failed:", error);
    return { gitDiffs: [], collectorProgress: ["diff_collector"] };
  }
}

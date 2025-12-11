import path from "path";
import { WorkflowState } from "../state";
import { ConfigManager } from "../../lib/config-manager";
import { progressTracker } from "../../lib/progress-tracker";
import { getRepoCommits } from "../../lib/git";

/**
 * Git Commit 收集器 - 运行命令获取 commit
 */
export async function collectGitCommits(state: WorkflowState) {
  const threadId = state.threadId || "unknown";

  progressTracker.updateProgress(threadId, {
    step: "collectGitCommits",
    status: "running",
    message: `正在收集 ${state.selectedRepos?.length || 0} 个仓库的提交记录...`,
    timestamp: Date.now(),
  });

  const configManager = ConfigManager.getInstance();
  const config = configManager.getActiveProfile();

  console.log(
    `📦 [Git Collector] 收集 Git commits... 选中仓库: ${
      state.selectedRepos?.length || 0
    }, authorPattern=${config.git.authorPattern || "未设置"}`
  );

  try {
    const repos = state.selectedRepos || [];
    const authorPattern = config.git.authorPattern || "";
    const since = state.since || config.git.since || "yesterday";
    const until = state.until || "";

    if (repos.length === 0) {
      progressTracker.updateProgress(threadId, {
        step: "collectGitCommits",
        status: "completed",
        message: "未选择任何仓库",
        timestamp: Date.now(),
      });
      return {
        gitCommits: "未选择任何 Git 仓库",
      };
    }

    const commitPromises = repos.map(async (repoPath) => {
      console.log(
        `[Git Collector] 读取仓库: ${repoPath}, since="${since}", until="${
          until || "now"
        }", author="${authorPattern}"`
      );
      const commits = await getRepoCommits(
        repoPath,
        authorPattern,
        since,
        until
      );

      console.log(
        `[Git Collector] ${repoPath} 获取到 ${
          commits ? commits.split("\n").length : 0
        } 条记录`
      );
      if (!commits) return null;
      const repoName = path.basename(repoPath);
      return `### ${repoName}\n${commits}`;
    });

    const results = await Promise.all(commitPromises);
    const validResults = results.filter((r) => r !== null);

    progressTracker.updateProgress(threadId, {
      step: "collectGitCommits",
      status: "completed",
      message: `成功收集 ${validResults.length} 个仓库的提交记录`,
      timestamp: Date.now(),
    });

    return {
      gitCommits:
        validResults.length > 0
          ? validResults.join("\n\n")
          : "今天没有提交记录",
    };
  } catch (error) {
    console.error("Git 收集失败:", error);
    progressTracker.updateProgress(threadId, {
      step: "collectGitCommits",
      status: "error",
      message: "Git 收集失败",
      isCritical: true,
      timestamp: Date.now(),
    });
    return {
      gitCommits: "无法获取 Git 记录",
    };
  }
}

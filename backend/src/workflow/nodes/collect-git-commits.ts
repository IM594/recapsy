import path from "path";
import { WorkflowState } from "../state";
import { getRepoCommits } from "../../lib/git";
import logger from "../../lib/logger";

/**
 * Git Commit 收集器 - 运行命令获取 commit
 */
export async function collectGitCommits(state: WorkflowState) {
  const startTime = Date.now();
  const repos = state.selectedRepos || [];

  // 在函数内部读取环境变量，确保 dotenv 已加载
  const authorPattern = process.env.GIT_AUTHOR_PATTERN || "";

  const since = state.since || "yesterday";
  const until = state.until || "";

  logger.step("📦", "Git Collector - 收集提交记录", {
    仓库数量: repos.length,
    时间范围: `${since} → ${until || "now"}`,
    作者过滤: authorPattern || "(未设置 - 将包含所有作者)",
    环境变量: `GIT_AUTHOR_PATTERN=${
      process.env.GIT_AUTHOR_PATTERN || "(未设置)"
    }`,
  });

  if (repos.length === 0) {
    logger.warn("未选择任何仓库");
    return {
      gitCommits: "未选择任何 Git 仓库",
    };
  }

  let totalCommits = 0;
  const commitPromises = repos.map(async (repoPath) => {
    const repoName = path.basename(repoPath);
    const commits = await getRepoCommits(repoPath, authorPattern, since, until);

    const commitCount = commits
      ? commits.split("\n").filter((l) => l.trim()).length
      : 0;
    totalCommits += commitCount;

    logger.info(`${repoName}: ${commitCount} 条提交`);

    if (!commits) return null;
    return `### ${repoName}\n${commits}`;
  });

  const results = await Promise.all(commitPromises);
  const validResults = results.filter((r) => r !== null) as string[];

  logger.stepDone(`共收集 ${totalCommits} 条提交`, Date.now() - startTime);

  return {
    gitCommits:
      validResults.length > 0 ? validResults.join("\n\n") : "今天没有提交记录",
  };
}

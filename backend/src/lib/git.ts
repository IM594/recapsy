import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";

const execAsync = promisify(exec);

export interface GitRepo {
  name: string;
  path: string;
}

/**
 * Find all git repositories in the given root directory.
 * Uses `find` command for performance.
 */
export async function findRepositories(rootDir: string): Promise<GitRepo[]> {
  try {
    // 验证路径,避免扫描系统根目录或敏感目录
    const normalizedPath = path.resolve(rootDir);
    console.log(`[Git] 扫描路径: ${normalizedPath}`);

    // 禁止扫描系统根目录和系统关键目录
    const forbiddenPaths = [
      "/",
      "/System",
      "/Library",
      "/private",
      "/usr",
      "/bin",
      "/sbin",
      "/var",
    ];
    if (forbiddenPaths.includes(normalizedPath) || normalizedPath.length < 5) {
      console.warn(`拒绝扫描系统目录: ${normalizedPath}`);
      return [];
    }

    // 检查目录是否存在
    try {
      await fs.access(normalizedPath);
    } catch {
      console.warn(`目录不存在: ${normalizedPath}`);
      return [];
    }

    // Find directories containing .git
    // -maxdepth 3 to avoid scanning too deep (adjust as needed)
    const command = `find "${normalizedPath}" -name ".git" -type d -maxdepth 3 -prune 2>/dev/null`;
    const { stdout } = await execAsync(command);
    console.log("[Git] find 命令执行完成");

    const repos = stdout
      .split("\n")
      .filter((line) => line.trim())
      .map((gitDir) => {
        const repoPath = path.dirname(gitDir);
        return {
          name: path.basename(repoPath),
          path: repoPath,
        };
      });

    return repos.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    console.error("Error finding repositories:", error);
    return [];
  }
}

/**
 * Get commits from a repository with filtering.
 */
export async function getRepoCommits(
  repoPath: string,
  authorPattern: string,
  since: string = "yesterday", // Default to过去24小时
  until: string = ""
): Promise<string> {
  try {
    // 先同步最新远端记录
    try {
      console.log(`[Git] fetch 开始: repo=${repoPath}`);
      await execAsync("git fetch --all --prune", { cwd: repoPath });
      console.log(`[Git] fetch 完成: repo=${repoPath}`);
    } catch (fetchErr) {
      console.warn(
        `[Git] fetch 失败(忽略继续): repo=${repoPath}, error=${
          (fetchErr as Error)?.message
        }`
      );
    }

    // git log -E --author "pattern" --since="since" --pretty=format:"%h - %s (%an)"
    // -E enables extended regex for author pattern
    // 用户要求移除数量限制，获取完整记录
    const includeStat = process.env.GIT_INCLUDE_STAT !== "0"; // 默认带 diffstat
    const authorClause = authorPattern ? `--author "${authorPattern}"` : "";
    const untilClause = until ? `--until="${until}"` : "";
    const statFlag = includeStat ? "--stat" : "";

    // 格式说明: Hash, AuthorName, AuthorDate(ISO), Subject
    // 移除 --max-count 参数
    const cmd = `git log -E --all ${authorClause} --since="${since}" ${untilClause} ${statFlag} --no-color --date=iso-strict --pretty=format:"COMMIT_START %h %an %ad %s"`;

    console.log(`[Git] 执行命令: ${cmd}`);

    const { stdout } = await execAsync(cmd, { cwd: repoPath });

    // 手动过滤 Author Date
    const sinceDate = new Date(since);
    const untilDate = until ? new Date(until) : new Date();

    // 检查 since 是否为有效日期 (如果是相对时间如 "yesterday"，则 new Date 可能无法解析或解析不准，甚至 Invalid Date)
    // 如果 since 是无效日期，说明是相对时间，我们信任 git log 的 --since 过滤结果（虽然是 commit date）
    const shouldFilterByAuthorDate = !isNaN(sinceDate.getTime());

    if (shouldFilterByAuthorDate) {
      console.log(
        `[Git] 启用应用层 Author Date 过滤: ${sinceDate.toISOString()} ~ ${untilDate.toISOString()}`
      );
    }

    const lines = stdout.split("\n");
    let filteredOutput = "";
    let currentCommitValid = false;
    let validCommitCount = 0;

    for (const line of lines) {
      if (line.startsWith("COMMIT_START ")) {
        // 解析 Header: COMMIT_START %h %an %ad %s
        // 示例: COMMIT_START abc1234 User 2025-12-01T12:00:00+08:00 Some message
        const parts = line.split(" ");
        if (parts.length >= 4) {
          const dateStr = parts[3]; // ISO String should be at index 3
          const authorDate = new Date(dateStr);

          if (shouldFilterByAuthorDate && !isNaN(authorDate.getTime())) {
            // Check range
            if (
              authorDate.getTime() >= sinceDate.getTime() &&
              authorDate.getTime() <= untilDate.getTime()
            ) {
              currentCommitValid = true;
              validCommitCount++;
              filteredOutput += line.replace("COMMIT_START ", "") + "\n";
            } else {
              currentCommitValid = false;
              // console.log(`[Git] 过滤掉过期 Commit: ${dateStr}`);
            }
          } else {
            // If date parsing failed or relative time used, pass through
            currentCommitValid = true;
            validCommitCount++;
            filteredOutput += line.replace("COMMIT_START ", "") + "\n";
          }
        } else {
          // Malformed header, pass through if currently valid
          if (currentCommitValid) filteredOutput += line + "\n";
        }
      } else {
        // Stat lines or other lines, append if belong to a valid commit
        if (currentCommitValid) {
          filteredOutput += line + "\n";
        }
      }
    }

    console.log(
      `[Git] 读取提交: repo=${repoPath}, since=${since}, 原始行数=${lines.length}, 过滤后 Commit 数=${validCommitCount}`
    );

    return filteredOutput.trim();
  } catch (error) {
    // Ignore errors (e.g. not a git repo, no commits)
    console.warn(`[Git] 获取提交失败: ${error}`);
    return "";
  }
}

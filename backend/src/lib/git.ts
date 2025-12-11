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
    const maxCommits = parseInt(process.env.GIT_MAX_COMMITS || "20", 10);
    const includeStat = process.env.GIT_INCLUDE_STAT !== "0"; // 默认带 diffstat
    const authorClause = authorPattern ? `--author "${authorPattern}"` : "";
    const untilClause = until ? `--until="${until}"` : "";
    const statFlag = includeStat ? "--stat" : "";

    const cmd = `git log -E --all ${authorClause} --since="${since}" ${untilClause} --max-count=${maxCommits} ${statFlag} --no-color --date=iso-strict --pretty=format:"%h %an %ad %s"`;

    console.log(`[Git] 执行命令: ${cmd}`);

    const { stdout } = await execAsync(cmd, { cwd: repoPath });

    console.log(
      `[Git] 读取提交: repo=${repoPath}, since=${since}, 获取行数=${
        stdout ? stdout.split("\n").length : 0
      }`
    );

    return stdout.trim();
  } catch (error) {
    // Ignore errors (e.g. not a git repo, no commits)
    return "";
  }
}

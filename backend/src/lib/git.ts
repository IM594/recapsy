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
    // 注意：since/until 可能是 "2025-12-11 00:00:00" 格式（本地时间），需要正确解析
    // JavaScript Date 对空格分隔的日期字符串解析行为不一致，需要转换为 ISO 格式
    const parseLocalDate = (dateStr: string): Date => {
      // 将 "2025-12-11 00:00:00" 转换为 "2025-12-11T00:00:00" 以正确解析为本地时间
      const normalized = dateStr.replace(" ", "T");
      return new Date(normalized);
    };

    const sinceDate = parseLocalDate(since);
    const untilDate = until ? parseLocalDate(until) : new Date();

    // 检查 since 是否为有效日期 (如果是相对时间如 "yesterday"，则 new Date 可能无法解析或解析不准，甚至 Invalid Date)
    // 如果 since 是无效日期，说明是相对时间，我们信任 git log 的 --since 过滤结果（虽然是 commit date）
    const shouldFilterByAuthorDate = !isNaN(sinceDate.getTime());

    if (shouldFilterByAuthorDate) {
      console.log(
        `[Git] 启用应用层 Author Date 过滤: ${sinceDate.toString()} ~ ${untilDate.toString()}`
      );
    }

    const lines = stdout.split("\n");
    let filteredOutput = "";
    let currentCommitValid = false;
    let validCommitCount = 0;

    for (const line of lines) {
      if (line.startsWith("COMMIT_START ")) {
        // 解析 Header: COMMIT_START %h %an %ad %s
        // 示例: COMMIT_START abc1234 Zhaohao Lu 2025-12-01T12:00:00+08:00 Some message
        // 注意: author name 可能包含空格，所以需要用正则匹配 ISO 日期
        const isoDateRegex =
          /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/;
        const dateMatch = line.match(isoDateRegex);

        if (dateMatch) {
          const dateStr = dateMatch[0];
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
              console.log(
                `[Git] 过滤掉超出范围的 Commit: ${dateStr} (范围: ${sinceDate.toISOString()} ~ ${untilDate.toISOString()})`
              );
            }
          } else {
            // If date parsing failed or relative time used, pass through
            currentCommitValid = true;
            validCommitCount++;
            filteredOutput += line.replace("COMMIT_START ", "") + "\n";
          }
        } else {
          // No date found in line, pass through if currently valid or skip filtering
          if (!shouldFilterByAuthorDate) {
            currentCommitValid = true;
            validCommitCount++;
            filteredOutput += line.replace("COMMIT_START ", "") + "\n";
          } else {
            // Malformed line with filtering enabled, skip
            currentCommitValid = false;
            console.log(`[Git] 无法解析日期的行: ${line.substring(0, 100)}`);
          }
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

export interface GitDiff {
  file: string;
  diff: string;
  tokenCount: number; // Estimated token count
}

/**
 * Get detailed diffs from a repository with intelligent filtering.
 */
export async function getRepoDiffs(
  repoPath: string,
  authorPattern: string,
  since: string = "yesterday",
  until: string = ""
): Promise<GitDiff[]> {
  try {
    // 1. Construct command
    const authorClause = authorPattern ? `--author "${authorPattern}"` : "";
    const untilClause = until ? `--until="${until}"` : "";

    // Using --name-only first to identify files, then getting diffs might be slow.
    // Let's use `git log -p` and parse it, but excluding obviously bad files first via pathspec is hard with `log`.
    // Better approach: `git log` to find commits, then `git show`? No, too many calls.
    // Use `git log -p` and strict parsing.

    // Add pathspec exclusions to git log directly (efficient)
    const excludeSpecs = [
      "':(exclude)package-lock.json'",
      "':(exclude)pnpm-lock.yaml'",
      "':(exclude)yarn.lock'",
      "':(exclude)*.lock'",
      "':(exclude)*.svg'",
      "':(exclude)*.png'",
      "':(exclude)*.jpg'",
      "':(exclude)*.jpeg'",
      "':(exclude)*.gif'",
      "':(exclude)*.ico'",
      "':(exclude)dist/*'",
      "':(exclude)build/*'",
      "':(exclude).next/*'",
      "':(exclude)node_modules/*'",
      "':(exclude)*.min.js'",
      "':(exclude)*.min.css'",
      "':(exclude)*.map'",
    ];

    const cmd = `git log -E --all ${authorClause} --since="${since}" ${untilClause} -p --no-color --date=iso-strict ${excludeSpecs.join(
      " "
    )}`;

    // Increase buffer size for large diffs
    const { stdout } = await execAsync(cmd, {
      cwd: repoPath,
      maxBuffer: 1024 * 1024 * 10,
    });

    // 2. Parse the massive diff output
    // Git diff format:
    // commit ...
    // ...
    // diff --git a/file b/file

    const diffs: GitDiff[] = [];
    const lines = stdout.split("\n");

    let currentFile = "";
    let currentDiffLines: string[] = [];

    // Limit per-file diff size (lines) to avoid one huge file eating all context
    const MAX_LINES_PER_FILE = 500;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith("diff --git")) {
        // Save previous file if exists
        if (currentFile && currentDiffLines.length > 0) {
          const diffContent = currentDiffLines.join("\n");
          // Estimate tokens (chars / 4)
          const tokenCount = Math.ceil(diffContent.length / 4);

          // Only add if it has content and reasonable size
          if (tokenCount > 0) {
            diffs.push({
              file: currentFile,
              diff: diffContent,
              tokenCount,
            });
          }
        }

        // Start new file
        // Format: diff --git a/path/to/file b/path/to/file
        const parts = line.split(" ");
        if (parts.length >= 4) {
          // extract filename (remove b/ prefix)
          const bPath = parts[3];
          currentFile = bPath.startsWith("b/") ? bPath.substring(2) : bPath;
        } else {
          currentFile = "unknown";
        }
        currentDiffLines = [line];
      } else {
        // Accumulate lines for current file
        if (currentFile) {
          if (currentDiffLines.length < MAX_LINES_PER_FILE) {
            currentDiffLines.push(line);
          } else if (currentDiffLines.length === MAX_LINES_PER_FILE) {
            currentDiffLines.push("... (Diff truncated due to size)");
          }
        }
      }
    }

    // Save last file
    if (currentFile && currentDiffLines.length > 0) {
      const diffContent = currentDiffLines.join("\n");
      diffs.push({
        file: currentFile,
        diff: diffContent,
        tokenCount: Math.ceil(diffContent.length / 4),
      });
    }

    // Merge diffs implementation detail:
    // Since git log shows commits sequentially, the same file might appear multiple times.
    // We should merge them or keep them separate?
    // Ideally we want "Net Change" for the file, but git log gives change per commit.
    // Merging diff chunks from different commits is hard.
    // A simpler way for "Summary": Group by filename and append diffs.

    const mergedDiffs = new Map<string, GitDiff>();

    for (const d of diffs) {
      if (mergedDiffs.has(d.file)) {
        const existing = mergedDiffs.get(d.file)!;
        existing.diff += "\n\n" + d.diff;
        existing.tokenCount += d.tokenCount;
      } else {
        mergedDiffs.set(d.file, d);
      }
    }

    return Array.from(mergedDiffs.values()).sort(
      (a, b) => b.tokenCount - a.tokenCount
    ); // Sort by size descending
  } catch (error) {
    console.warn(`[Git] 获取 Diff 失败: ${error}`);
    return [];
  }
}

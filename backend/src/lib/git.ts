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
    // 先同步最新远端记录（静默执行）
    try {
      await execAsync("git fetch --all --prune", { cwd: repoPath });
    } catch (fetchErr) {
      // 忽略 fetch 错误
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

    // 应用层过滤（静默）

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
              // 静默过滤
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
          }
        }
      } else {
        // Stat lines or other lines, append if belong to a valid commit
        if (currentCommitValid) {
          filteredOutput += line + "\n";
        }
      }
    }

    // 日志已在上层输出

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
      // Lock files
      "':(exclude)package-lock.json'",
      "':(exclude)pnpm-lock.yaml'",
      "':(exclude)yarn.lock'",
      "':(exclude)*.lock'",
      // Binary / media files
      "':(exclude)*.svg'",
      "':(exclude)*.png'",
      "':(exclude)*.jpg'",
      "':(exclude)*.jpeg'",
      "':(exclude)*.gif'",
      "':(exclude)*.ico'",
      "':(exclude)*.woff'",
      "':(exclude)*.woff2'",
      "':(exclude)*.ttf'",
      "':(exclude)*.eot'",
      "':(exclude)*.pdf'",
      "':(exclude)*.mp3'",
      "':(exclude)*.mp4'",
      "':(exclude)*.webp'",
      // Build output
      "':(exclude)dist/*'",
      "':(exclude)build/*'",
      "':(exclude).next/*'",
      "':(exclude).nuxt/*'",
      "':(exclude).output/*'",
      "':(exclude)out/*'",
      "':(exclude)node_modules/*'",
      // Minified / bundled
      "':(exclude)*.min.js'",
      "':(exclude)*.min.css'",
      "':(exclude)*.bundle.js'",
      "':(exclude)*.bundle.css'",
      "':(exclude)*.map'",
      // Generated / auto
      "':(exclude)*.generated.*'",
      "':(exclude)*.auto.*'",
      "':(exclude)*.d.ts'",
      // Test / coverage / snapshots
      "':(exclude)*.test.ts'",
      "':(exclude)*.test.tsx'",
      "':(exclude)*.spec.ts'",
      "':(exclude)*.spec.tsx'",
      "':(exclude)__snapshots__/*'",
      "':(exclude)coverage/*'",
      // Config templates
      "':(exclude).env.example'",
      "':(exclude).env.local'",
      "':(exclude).env.*.local'",
      // Cache / temp
      "':(exclude).turbo/*'",
      "':(exclude).cache/*'",
      "':(exclude).temp/*'",
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

// ============ Year-End Summary Functions ============

import type { CommitInfo, DailyCommitData, FileChange } from "./types";

/**
 * Get commits from multiple repos, grouped by date.
 * This is the primary data collection function for year-end summaries.
 */
export async function getCommitsByDay(
  repoPaths: string[],
  authorPattern: string,
  since: string,
  until: string,
  options: {
    includeDiffs?: boolean;
    maxDiffLinesPerFile?: number;
    maxFilesPerDay?: number;
  } = {}
): Promise<DailyCommitData[]> {
  const {
    includeDiffs = true,
    maxDiffLinesPerFile = 100,
    maxFilesPerDay = 30,
  } = options;

  // Map: date -> DailyCommitData
  const dailyMap = new Map<string, DailyCommitData>();

  // 并发收集所有仓库的提交
  const results = await Promise.allSettled(
    repoPaths.map(async (repoPath) => {
      const repoName = path.basename(repoPath);
      console.log(`[Git] Collecting commits from ${repoName}...`);

      try {
        // Fetch latest
        try {
          await execAsync("git fetch --all --prune", { cwd: repoPath });
        } catch {
          // Ignore fetch errors
        }

        const authorClause = authorPattern ? `--author "${authorPattern}"` : "";
        const untilClause = until ? `--until="${until}"` : "";

        // Get structured commit data
        // Format: hash|author|date|subject
        const formatStr = "%H|%an|%aI|%s";
        const cmd = `git log -E --all ${authorClause} --since="${since}" ${untilClause} --no-color --pretty=format:"${formatStr}"`;

        const { stdout } = await execAsync(cmd, {
          cwd: repoPath,
          maxBuffer: 1024 * 1024 * 50, // 50MB buffer for large repos
        });

        if (!stdout.trim()) {
          console.log(`[Git] ${repoName}: no commits found`);
          return { repoName, commits: [] };
        }

        const lines = stdout.trim().split("\n");
        const repoCommits: Array<{
          dateOnly: string;
          commitInfo: CommitInfo;
        }> = [];

        for (const line of lines) {
          const parts = line.split("|");
          if (parts.length < 4) continue;

          const [hash, author, authorDate, ...messageParts] = parts;
          const message = messageParts.join("|"); // In case message contains |
          const dateOnly = authorDate.split("T")[0]; // YYYY-MM-DD

          // Get file stats for this commit
          let files: FileChange[] = [];
          let diffContent: string | undefined;

          try {
            // Get numstat for file changes
            const statCmd = `git show ${hash} --numstat --format=""`;
            const { stdout: statOut } = await execAsync(statCmd, {
              cwd: repoPath,
            });

            const statLines = statOut.trim().split("\n").filter(Boolean);
            let fileCount = 0;

            for (const statLine of statLines) {
              if (fileCount >= maxFilesPerDay) break;

              const [add, del, filePath] = statLine.split("\t");
              if (!filePath) continue;

              // Skip binary files (shown as - - in numstat)
              if (add === "-" || del === "-") continue;

              files.push({
                path: filePath,
                additions: parseInt(add) || 0,
                deletions: parseInt(del) || 0,
              });
              fileCount++;
            }

            // Get diff if requested
            if (includeDiffs && files.length > 0) {
              // Build exclusion pathspec
              const excludeSpecs = [
                "':(exclude)package-lock.json'",
                "':(exclude)pnpm-lock.yaml'",
                "':(exclude)yarn.lock'",
                "':(exclude)*.lock'",
                "':(exclude)*.min.js'",
                "':(exclude)*.min.css'",
                "':(exclude)*.map'",
                "':(exclude)*.d.ts'",
                "':(exclude)dist/*'",
                "':(exclude)build/*'",
                "':(exclude)node_modules/*'",
              ];

              const diffCmd = `git show ${hash} --no-color -p ${excludeSpecs.join(
                " "
              )}`;
              const { stdout: diffOut } = await execAsync(diffCmd, {
                cwd: repoPath,
                maxBuffer: 1024 * 1024 * 5, // 5MB per commit
              });

              // Truncate diff if too long
              const diffLines = diffOut.split("\n");
              if (diffLines.length > maxDiffLinesPerFile * files.length) {
                diffContent = diffLines
                  .slice(0, maxDiffLinesPerFile * Math.min(files.length, 10))
                  .join("\n");
                diffContent += "\n... (diff truncated)";
              } else {
                diffContent = diffOut;
              }
            }
          } catch {
            // Ignore errors getting file stats
          }

          const commitInfo: CommitInfo = {
            hash: hash.substring(0, 8),
            author,
            authorDate,
            message,
            files,
            diff: diffContent,
          };

          repoCommits.push({ dateOnly, commitInfo });
        }

        console.log(`[Git] ${repoName}: collected ${lines.length} commits`);
        return { repoName, commits: repoCommits };
      } catch (error) {
        console.warn(`[Git] Error collecting from ${repoName}:`, error);
        return { repoName, commits: [] };
      }
    })
  );

  // 合并所有仓库的结果到 dailyMap
  for (const result of results) {
    if (result.status === "fulfilled") {
      const { repoName, commits } = result.value;

      for (const { dateOnly, commitInfo } of commits) {
        // Add to daily map
        if (!dailyMap.has(dateOnly)) {
          dailyMap.set(dateOnly, {
            date: dateOnly,
            commits: [],
            repos: [],
            stats: {
              totalCommits: 0,
              totalAdditions: 0,
              totalDeletions: 0,
              filesChanged: 0,
            },
          });
        }

        const daily = dailyMap.get(dateOnly)!;
        daily.commits.push(commitInfo);
        daily.stats.totalCommits++;
        daily.stats.totalAdditions += commitInfo.files.reduce(
          (sum, f) => sum + f.additions,
          0
        );
        daily.stats.totalDeletions += commitInfo.files.reduce(
          (sum, f) => sum + f.deletions,
          0
        );
        daily.stats.filesChanged += commitInfo.files.length;

        if (!daily.repos.includes(repoName)) {
          daily.repos.push(repoName);
        }
      }
    }
  }

  // Convert to sorted array (ascending by date)
  const result = Array.from(dailyMap.values()).sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  console.log(`[Git] Total: ${result.length} days with commits`);
  return result;
}

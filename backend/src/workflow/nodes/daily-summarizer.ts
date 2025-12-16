/**
 * Daily Summarizer - Process a single day's commits and generate summary
 */

import { createLLM, invokeWithRetry } from "../../lib/llm";
import type { DailyCommitData, DailySummary } from "../../lib/types";
import logger from "../../lib/logger";

/**
 * Generate a summary for a single day's work
 */
export async function processDailySummary(
  dailyData: DailyCommitData & { additionalInstructions?: string }
): Promise<DailySummary> {
  const startTime = Date.now();

  logger.step("📝", `Daily Summary - ${dailyData.date}`, {
    commits: dailyData.stats.totalCommits,
    repo: dailyData.repo,
    changes: `+${dailyData.stats.totalAdditions} / -${dailyData.stats.totalDeletions}`,
  });

  // Build commit summary for prompt
  const commitSummaries = dailyData.commits.map((c) => {
    const filesStr = c.files
      .slice(0, 5)
      .map((f) => `  - ${f.path} (+${f.additions}/-${f.deletions})`)
      .join("\n");
    return `- [${c.hash}] ${c.message}\n${filesStr}`;
  });

  // Include diffs if available (truncated)
  let diffSection = "";
  const diffsWithContent = dailyData.commits.filter((c) => c.diff);
  if (diffsWithContent.length > 0) {
    const sampleDiffs = diffsWithContent
      .slice(0, 3)
      .map((c) => {
        const truncatedDiff = c.diff!.substring(0, 2000);
        return `### ${c.message}\n\`\`\`diff\n${truncatedDiff}\n\`\`\``;
      })
      .join("\n\n");
    diffSection = `

## 代码变更摘要
${sampleDiffs}`;
  }

  const prompt = `你是一个工作总结助手。请根据以下 Git 提交记录，生成一份简洁的每日工作总结。

## 日期
${dailyData.date}

## 涉及仓库
${dailyData.repo}

## 提交记录
${commitSummaries.join("\n\n")}
${diffSection}

## 额外指令
${
  dailyData.additionalInstructions
    ? `> ${dailyData.additionalInstructions}`
    : "无"
}

## 要求
1. 用自然语言描述今天完成的主要工作，保留专有名词，不要直接复制 commit message
2. 将相关的小提交合并为一个工作项描述
3. 提取 3-5 个关键变更点
4. 总计不超过 300 字

## 输出格式
### 今日工作
（一段话描述今天的工作内容）

### 关键变更
- 变更1
- 变更2
- ...`;

  const model = createLLM({ temperature: 0.5 });

  const summary = await invokeWithRetry(model, prompt);

  // Extract key changes from the summary (simple parsing)
  const keyChanges: string[] = [];
  const lines = summary.split("\n");
  let inKeyChanges = false;

  for (const line of lines) {
    if (line.includes("关键变更") || line.includes("Key Changes")) {
      inKeyChanges = true;
      continue;
    }
    if (inKeyChanges && line.startsWith("- ")) {
      keyChanges.push(line.substring(2).trim());
    }
    if (inKeyChanges && line.startsWith("###")) {
      break;
    }
  }

  const result: DailySummary = {
    date: dailyData.date,
    repo: dailyData.repo,
    summary,
    keyChanges: keyChanges.length > 0 ? keyChanges : ["无明显变更"],
    tokensUsed: Math.ceil(prompt.length / 4) + Math.ceil(summary.length / 4),
  };

  logger.stepDone(`生成 ${summary.length} 字符`, Date.now() - startTime);

  return result;
}

/**
 * Process multiple days in batch with error handling (concurrent)
 */
export async function processDailySummariesBatch(
  dailyDataList: DailyCommitData[],
  onProgress?: (completed: number, total: number, date: string) => void,
  onError?: (date: string, error: Error) => void
): Promise<{
  summaries: DailySummary[];
  errors: Array<{ date: string; error: string }>;
}> {
  const summaries: DailySummary[] = [];
  const errors: Array<{ date: string; error: string }> = [];
  const total = dailyDataList.length;

  // Process in chunks to limit concurrency
  const CONCURRENCY_LIMIT = 5;
  const results: PromiseSettledResult<
    | { success: true; summary: DailySummary; date: string }
    | { success: false; error: string; date: string }
  >[] = [];

  for (let i = 0; i < dailyDataList.length; i += CONCURRENCY_LIMIT) {
    const chunk = dailyDataList.slice(i, i + CONCURRENCY_LIMIT);

    const chunkResults = await Promise.allSettled(
      chunk.map(
        async (
          dailyData
        ): Promise<
          | { success: true; summary: DailySummary; date: string }
          | { success: false; error: string; date: string }
        > => {
          try {
            const summary = await processDailySummary(dailyData);
            onProgress?.(
              summaries.length + results.length + 1,
              total,
              dailyData.date
            ); // Approximate progress
            return { success: true, summary, date: dailyData.date };
          } catch (error) {
            const errMsg =
              error instanceof Error ? error.message : String(error);
            onError?.(dailyData.date, error as Error);
            logger.error(`Failed to process ${dailyData.date}: ${errMsg}`);
            return { success: false, error: errMsg, date: dailyData.date };
          }
        }
      )
    );

    results.push(...chunkResults);

    // Optional: Small delay between chunks to be nicer to the API
    if (i + CONCURRENCY_LIMIT < dailyDataList.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // 收集结果
  for (const result of results) {
    if (result.status === "fulfilled") {
      const data = result.value;
      if (data.success) {
        summaries.push(data.summary);
      } else {
        errors.push({ date: data.date, error: data.error });
      }
    } else {
      // Promise rejected (unlikely with try-catch inside)
      errors.push({
        date: "unknown",
        error: result.reason?.message || String(result.reason),
      });
    }
  }

  return { summaries, errors };
}

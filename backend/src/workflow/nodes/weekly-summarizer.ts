/**
 * Weekly Summarizer Node - Aggregate daily summaries into weekly report
 */

import { createLLM, invokeWithRetry } from "../../lib/llm";
import { WorkflowState } from "../state";
import { SummaryStore } from "../../lib/summary-store";
import type { WeeklySummary, DailySummary } from "../../lib/types";
import logger from "../../lib/logger";

/**
 * Get the Monday of the week for a given date
 */
function getWeekStart(dateStr: string): string {
  const d = new Date(dateStr);
  const day = d.getDay();
  // If Sunday (0), subtract 6 days. Else subtract day-1
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  return monday.toISOString().slice(0, 10);
}

/**
 * Get the Sunday of the week for a given start date
 */
function getWeekEnd(weekStart: string): string {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + 6);
  return d.toISOString().slice(0, 10);
}

/**
 * Process weekly summary from daily summaries
 */
export async function processWeeklySummary(
  weekStart: string,
  weekEnd: string,
  dailySummaries: DailySummary[],
  customPrompt?: string
): Promise<WeeklySummary> {
  const totalDays = dailySummaries.length;
  const model = createLLM({ temperature: 0.3 });

  // Build context for AI
  const dailyDetails = dailySummaries
    .map((d) => `**${d.date}** (${d.repo}):\n${d.summary}`)
    .join("\n\n");

  const prompt = `你是一个工作总结助手。请根据以下每日工作总结，生成一份结构化的周报。

## 时间范围
${weekStart} 至 ${weekEnd}

## 每日工作摘要
${dailyDetails}

${customPrompt ? `## 额外指令\n> ${customPrompt}\n` : ""}

## 要求
1. 用自然语言描述本周完成的主要工作，整合相关的日常工作
2. 提取 3-5 个关键成果或亮点
3. 使用中文输出
4. 总计不超过 500 字

## 输出格式（严格使用 Markdown）
### 本周工作
（一段话总结本周的整体工作内容，突出主要成就和进展）

### 关键成果
- 成果1：具体描述
- 成果2：具体描述
- 成果3：具体描述
...`;

  const summaryText = await invokeWithRetry(model, prompt);

  return {
    weekStart,
    weekEnd,
    summary: summaryText, // 直接使用 Markdown 文本
    highlights: [], // 空数组，因为已包含在 summary 中
    daysWithWork: totalDays,
  };
}

/**
 * Process all weekly summaries for the given daily summaries
 */
export async function processAllWeeklySummaries(
  dailySummaries: DailySummary[],
  onProgress?: (completed: number, total: number, week: string) => void
): Promise<{
  summaries: WeeklySummary[];
  errors: Array<{ week: string; error: string }>;
}> {
  // Group by week
  const weeklyGroups = new Map<string, DailySummary[]>();

  for (const daily of dailySummaries) {
    const weekStart = getWeekStart(daily.date);
    if (!weeklyGroups.has(weekStart)) {
      weeklyGroups.set(weekStart, []);
    }
    weeklyGroups.get(weekStart)!.push(daily);
  }

  const weeks = Array.from(weeklyGroups.keys()).sort();
  const summaries: WeeklySummary[] = [];
  const errors: Array<{ week: string; error: string }> = [];

  // Same concurrency limit as other batch processors
  const CONCURRENCY_LIMIT = 5;

  for (let i = 0; i < weeks.length; i += CONCURRENCY_LIMIT) {
    const chunk = weeks.slice(i, i + CONCURRENCY_LIMIT);

    const chunkResults = await Promise.allSettled(
      chunk.map(async (weekStart) => {
        const dailies = weeklyGroups.get(weekStart)!;
        const weekEnd = getWeekEnd(weekStart);

        try {
          // Sort dailies by date just in case
          dailies.sort((a, b) => a.date.localeCompare(b.date));

          const summary = await processWeeklySummary(
            weekStart,
            weekEnd,
            dailies
          );
          onProgress?.(summaries.length + 1, weeks.length, weekStart);
          return { success: true as const, summary };
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          logger.error(`Failed to process week ${weekStart}: ${errMsg}`);
          return { success: false as const, week: weekStart, error: errMsg };
        }
      })
    );

    // Collect results
    for (const result of chunkResults) {
      if (result.status === "fulfilled") {
        const data = result.value;
        if (data.success) {
          summaries.push(data.summary);
        } else {
          errors.push({ week: data.week, error: data.error });
        }
      }
    }

    // Small delay between chunks
    if (i + CONCURRENCY_LIMIT < weeks.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  return { summaries, errors };
}

/**
 * LangGraph node: Weekly Summarizer
 *
 * Pure function: Only modifies state, no side effects
 */
export async function weeklySummarizerNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  const { dailySummaries, year, selectedRepos, authorPattern } = state;

  const checkpoint = SummaryStore.getInstance(year);
  await checkpoint.initialize(selectedRepos || [], authorPattern || "");

  if (!dailySummaries || dailySummaries.length === 0) {
    logger.warn("No daily summaries to aggregate for weekly");
    return {
      weeklySummaries: [],
      progress: state.taskType === "yearly" ? 70 : 80,
      currentStep: "weekly_summarizer",
    };
  }

  // Check which weeks we already have
  const weeklyGroups = new Map<string, DailySummary[]>();
  for (const daily of dailySummaries) {
    const weekStart = getWeekStart(daily.date);
    if (!weeklyGroups.has(weekStart)) weeklyGroups.set(weekStart, []);
    weeklyGroups.get(weekStart)!.push(daily);
  }

  const weeks = Array.from(weeklyGroups.keys()).sort();

  // Filter out cached ones
  const toProcess: DailySummary[] = [];
  const cached: WeeklySummary[] = [];

  for (const weekStart of weeks) {
    if (checkpoint.hasWeeklySummary(weekStart)) {
      const existing = await checkpoint.loadWeeklySummary(weekStart);
      if (existing) {
        cached.push(existing);
        continue;
      }
    }
    // Add all dailies for this week to toProcess
    toProcess.push(...weeklyGroups.get(weekStart)!);
  }

  logger.info(
    `📦 Weekly cache hit: ${cached.length}/${weeks.length}, Weeks to process: ${
      weeks.length - cached.length
    }`
  );

  // Process without progress callback (pure function)
  const { summaries: newSummaries, errors } = await processAllWeeklySummaries(
    toProcess
  );

  // Save new summaries
  for (const summary of newSummaries) {
    await checkpoint.saveWeeklySummary(summary);
  }

  if (errors.length > 0) {
    logger.warn(`⚠️  ${errors.length} weeks failed to process`);
  }

  // Merge and sort
  const allWeeklySummaries = [...cached, ...newSummaries].sort((a, b) =>
    a.weekStart.localeCompare(b.weekStart)
  );

  logger.stepDone(
    `Weekly summaries generated (${allWeeklySummaries.length} weeks)`,
    0
  );

  return {
    weeklySummaries: allWeeklySummaries,
    progress: state.taskType === "yearly" ? 80 : 90,
    currentStep: "weekly_summarizer",
  };
}

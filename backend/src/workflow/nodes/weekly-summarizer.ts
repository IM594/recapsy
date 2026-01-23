/**
 * Weekly Summarizer Node - Aggregate daily summaries into weekly report
 */

import { createLLM, invokeWithRetry } from "../../lib/llm";
import { WorkflowState } from "../state";
import { SummaryStore } from "../../lib/summary-store";
import type { WeeklySummary, DailySummary } from "../../lib/types";
import logger from "../../lib/logger";
import { getIsoWeekEndYmd, getIsoWeekStartYmd, isYmd, SUMMARY_TYPES, WORKFLOW_STEP_IDS } from "@recaply/shared";

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
  const model = createLLM({ temperature: 1.0, tier: "balanced" });

  // Build context for AI
  const dailyDetails = dailySummaries
    .map((d) => `**${d.date}** (${d.repo}):\n${d.summary}`)
    .join("\n\n");

  const prompt = `你是一个工作整理助手。请根据以下每日工作记录，生成一份结构化的周报。直接输出结果，请勿输出类似于“好的”、“好的，我明白了”等类似内容。

## 时间范围
${weekStart} 至 ${weekEnd}

## 每日工作摘要
${dailyDetails}

${customPrompt ? `## 额外指令\n> ${customPrompt}\n` : ""}

## 要求
1. 将碎片化的日常工作**归纳整合**为完整的工作项
2. 保留关键技术细节，但不要逐天罗列
3. 如有跨天的协作或帮助他人的记录，归纳到协作部分
4. 用事实陈述，不过度夸大成果
5. **保留专有名词**（项目名、技术名、模块名），不要翻译成中文
6. **不要使用表格格式**，只使用列表和段落
7. 总计不超过 600 字

## 输出格式（严格使用 Markdown）
### 本周工作
（一段话总结本周的整体工作内容）

### 完成的工作项
1. **工作项1**：具体描述，包含关键技术细节
2. **工作项2**：具体描述
...

### 协作记录（如有）
- 与谁协作了什么？帮助解决了什么问题？`;

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
    if (!isYmd(daily.date)) {
      logger.warn("weekly: invalid daily date; skipping");
      logger.debug("daily", { date: daily.date, repo: daily.repo });
      continue;
    }
    const weekStart = getIsoWeekStartYmd(daily.date);
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
  let processingIndex = 0; // Track the absolute index of item being processed

  for (let i = 0; i < weeks.length; i += CONCURRENCY_LIMIT) {
    const chunk = weeks.slice(i, i + CONCURRENCY_LIMIT);

    const chunkResults = await Promise.allSettled(
      chunk.map(async (weekStart) => {
        const dailies = weeklyGroups.get(weekStart)!;
        const weekEnd = getIsoWeekEndYmd(weekStart);

        processingIndex++; // Increment for each item as we schedule it
        const currentIndex = processingIndex;

        try {
          // Sort dailies by date just in case
          dailies.sort((a, b) => a.date.localeCompare(b.date));

          onProgress?.(currentIndex, weeks.length, weekStart);

          const summary = await processWeeklySummary(
            weekStart,
            weekEnd,
            dailies
          );
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

import { WorkflowRunner } from "../../lib/workflow-runner";

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
  const runner = WorkflowRunner.getInstance(year); // Get runner for progress updates

  await checkpoint.initialize(selectedRepos || [], authorPattern || "");

  if (!dailySummaries || dailySummaries.length === 0) {
    logger.warn("No daily summaries to aggregate for weekly");
    return {
      weeklySummaries: [],
      progress: state.taskType === SUMMARY_TYPES.yearly ? 70 : 80,
      currentStep: WORKFLOW_STEP_IDS.weeklySummarizer,
    };
  }

  // Check which weeks we already have
  const weeklyGroups = new Map<string, DailySummary[]>();
  for (const daily of dailySummaries) {
    if (!isYmd(daily.date)) {
      logger.warn("weekly: invalid daily date; skipping");
      logger.debug("daily", { date: daily.date, repo: daily.repo });
      continue;
    }
    const weekStart = getIsoWeekStartYmd(daily.date);
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

  // Process with progress callback
  const { summaries: newSummaries, errors } = await processAllWeeklySummaries(
    toProcess,
    (completed, total, weekStart) => {
      // Phase range: 0% -> 100%
      const percent = Math.floor((completed / total) * 100);

      runner.updateProgress(
        WORKFLOW_STEP_IDS.weeklySummarizer,
        percent,
        `Processing Week ${weekStart} (${completed}/${total})...`
      );
    }
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
    progress: state.taskType === SUMMARY_TYPES.yearly ? 80 : 90,
    currentStep: WORKFLOW_STEP_IDS.weeklySummarizer,
  };
}

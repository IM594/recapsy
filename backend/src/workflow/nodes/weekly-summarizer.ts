/**
 * Weekly Summarizer Node - Aggregate daily summaries into weekly report
 */

import { createLLM } from "../../lib/llm";
import { WorkflowState } from "../state";
import { CheckpointManager } from "../../lib/checkpoint";
import type { WeeklySummary, DailySummary } from "../../lib/types";
import logger from "../../lib/logger";

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

  const response = await model.invoke(prompt);
  const summaryText = response.content as string;

  return {
    weekStart,
    weekEnd,
    summary: summaryText, // 直接使用 Markdown 文本
    highlights: [], // 空数组，因为已包含在 summary 中
    daysWithWork: totalDays,
  };
}

/**
 * Normalize date string to YYYY-MM-DD format
 */
function toDateString(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-CA");
}

/**
 * LangGraph node: Weekly Summarizer
 */
export async function weeklySummarizerNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  const { dailySummaries, since, until, year, selectedRepos, authorPattern } =
    state;

  // Normalize dates to YYYY-MM-DD format for consistent storage
  const weekStart = toDateString(since);
  const weekEnd = toDateString(until);

  const checkpoint = CheckpointManager.getInstance(year);
  await checkpoint.initialize(selectedRepos || [], authorPattern || "");

  // Check if already exists
  if (checkpoint.hasWeeklySummary(weekStart)) {
    const existing = await checkpoint.loadWeeklySummary(weekStart);
    if (existing) {
      logger.info(`Loaded existing weekly summary for ${weekStart}`);
      return {
        weeklySummaries: [existing],
        progress: 80,
        currentStep: "weekly_summarizer",
      };
    }
  }

  logger.step("📅", "Weekly Summary - Aggregating daily summaries", {
    dailies: (dailySummaries || []).length,
    range: `${weekStart} → ${weekEnd}`,
  });

  if (!dailySummaries || dailySummaries.length === 0) {
    logger.warn("No daily summaries to aggregate for weekly");
    return {
      weeklySummaries: [],
      progress: 80,
      currentStep: "weekly_summarizer",
    };
  }

  const weeklySummary = await processWeeklySummary(
    weekStart,
    weekEnd,
    dailySummaries
  );

  await checkpoint.saveWeeklySummary(weeklySummary);

  logger.stepDone(
    `Weekly summary generated (${dailySummaries.length} days)`,
    0
  );

  return {
    weeklySummaries: [weeklySummary],
    progress: 80,
    currentStep: "weekly_summarizer",
  };
}

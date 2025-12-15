/**
 * Monthly Summarizer - Aggregate daily summaries into monthly report
 */

import { ChatOpenAI } from "@langchain/openai";
import type { DailySummary, MonthlySummary } from "../../lib/types";
import logger from "../../lib/logger";

/**
 * Generate a monthly summary from daily summaries
 */
export async function processMonthSummary(
  month: string, // YYYY-MM format
  dailySummaries: DailySummary[]
): Promise<MonthlySummary> {
  const startTime = Date.now();

  logger.step("📅", `Monthly Summary - ${month}`, {
    daysWithWork: dailySummaries.length,
  });

  // Build daily summaries for prompt
  const dailySummaryTexts = dailySummaries.map((d) => {
    return `### ${d.date}\n${d.summary}`;
  });

  const prompt = `你是一个工作总结助手。请根据以下每日工作总结，生成一份月度工作报告。

## 月份
${month}

## 每日总结
${dailySummaryTexts.join("\n\n---\n\n")}

## 要求
1. 归纳本月的主要工作成果，而不是简单罗列每天的工作
2. 提取 3-5 个本月亮点
3. 用自然语言描述，适合汇报给管理者
4. 总计不超过 500 字

## 输出格式
### 本月概述
（一段话概述本月工作）

### 主要成果
1. 成果1
2. 成果2
...

### 月度亮点
- 亮点1
- 亮点2
...`;

  // 在运行时读取环境变量,确保 dotenv 已加载
  const AI_MODEL = process.env.AI_MODEL_NAME;
  const AI_BASE_URL = process.env.OPENAI_BASE_URL;
  const AI_API_KEY = process.env.OPENAI_API_KEY;

  const model = new ChatOpenAI({
    modelName: AI_MODEL,
    temperature: 0.5,
    openAIApiKey: AI_API_KEY,
    configuration: {
      baseURL: AI_BASE_URL,
    },
  });

  const response = await model.invoke(prompt);
  const summary = String(response.content);

  // Extract highlights
  const highlights: string[] = [];
  const lines = summary.split("\n");
  let inHighlights = false;

  for (const line of lines) {
    if (line.includes("亮点") || line.includes("Highlights")) {
      inHighlights = true;
      continue;
    }
    if (inHighlights && line.startsWith("- ")) {
      highlights.push(line.substring(2).trim());
    }
    if (inHighlights && line.startsWith("###")) {
      break;
    }
  }

  const result: MonthlySummary = {
    month,
    summary,
    highlights: highlights.length > 0 ? highlights : ["本月工作平稳"],
    daysWithWork: dailySummaries.length,
  };

  logger.stepDone(`生成 ${summary.length} 字符`, Date.now() - startTime);

  return result;
}

/**
 * Group daily summaries by month and process each month
 */
export async function processAllMonthlySummaries(
  dailySummaries: DailySummary[],
  onProgress?: (completed: number, total: number, month: string) => void
): Promise<{
  summaries: MonthlySummary[];
  errors: Array<{ month: string; error: string }>;
}> {
  // Group by month
  const monthlyGroups = new Map<string, DailySummary[]>();

  for (const daily of dailySummaries) {
    const month = daily.date.substring(0, 7); // YYYY-MM
    if (!monthlyGroups.has(month)) {
      monthlyGroups.set(month, []);
    }
    monthlyGroups.get(month)!.push(daily);
  }

  const months = Array.from(monthlyGroups.keys()).sort();
  const summaries: MonthlySummary[] = [];
  const errors: Array<{ month: string; error: string }> = [];

  for (let i = 0; i < months.length; i++) {
    const month = months[i];
    const dailies = monthlyGroups.get(month)!;

    try {
      const summary = await processMonthSummary(month, dailies);
      summaries.push(summary);
      onProgress?.(i + 1, months.length, month);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      errors.push({ month, error: errMsg });
      logger.error(`Failed to process ${month}: ${errMsg}`);
    }

    // Small delay between API calls
    if (i < months.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return { summaries, errors };
}

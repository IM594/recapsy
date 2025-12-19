import { StateGraph, END, START } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { WorkflowStateAnnotation, WorkflowState } from "./state";
import {
  collectDataNode,
  weeklySummarizerNode,
  persistNode,
} from "./nodes/index";
import { processDailySummariesBatch } from "./nodes/daily-summarizer";
import {
  processMonthSummary,
  processAllMonthlySummaries,
} from "./nodes/monthly-summarizer";
import { processYearEndSummary } from "./nodes/year-end-summarizer";
import { CheckpointManager } from "../lib/checkpoint";
import type { DailySummary, MonthlySummary } from "../lib/types";
import logger from "../lib/logger";

/**
 * Daily Summarizer Node - Process all collected daily data (concurrent)
 */
async function dailySummarizerNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  const { rawCommits, year, selectedRepos, authorPattern } = state;
  const checkpoint = CheckpointManager.getInstance(year);
  await checkpoint.initialize(selectedRepos || [], authorPattern || "");

  const commits = rawCommits || [];
  const total = commits.length;

  // 分离已缓存和需要处理的数据
  const toProcess: typeof commits = [];
  const cached: DailySummary[] = [];

  for (const dayData of commits) {
    if (checkpoint.hasDailySummary(dayData.date, dayData.repo)) {
      const existing = await checkpoint.loadDailySummary(
        dayData.date,
        dayData.repo
      );
      if (existing) {
        cached.push(existing);
        continue;
      }
    }
    toProcess.push(dayData);
  }

  logger.info(
    `📦 缓存命中: ${cached.length}/${total}, 需处理: ${toProcess.length}`
  );

  // 并发处理所有未缓存的数据
  let completed = cached.length;
  const { summaries: newSummaries, errors } = await processDailySummariesBatch(
    toProcess,
    async (count, total, date) => {
      completed++;
      const progress = 20 + Math.round((completed / commits.length) * 40);
      await checkpoint.updateProgress(
        "daily_summarizer",
        progress,
        `Processed ${date} (${completed}/${commits.length})`
      );
    },
    (date, error) => {
      logger.error(`❌ Failed to process ${date}: ${error.message}`);
    }
  );

  // 保存新生成的 summaries
  for (const summary of newSummaries) {
    await checkpoint.saveDailySummary(summary);
  }

  // 合并缓存和新生成的结果
  const dailySummaries = [...cached, ...newSummaries];

  if (errors.length > 0) {
    logger.warn(`⚠️  ${errors.length} days failed to process`);
  }

  return { dailySummaries, progress: 60, currentStep: "daily_summarizer" };
}

/**
 * Monthly Summarizer Node - Aggregate daily summaries into monthly reports (concurrent)
 */
async function monthlySummarizerNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  const { dailySummaries, year, selectedRepos, authorPattern } = state;
  const checkpoint = CheckpointManager.getInstance(year);
  await checkpoint.initialize(selectedRepos || [], authorPattern || "");

  // Group by month
  const monthsMap = new Map<string, DailySummary[]>();
  for (const daily of dailySummaries || []) {
    const month = daily.date.substring(0, 7); // YYYY-MM
    if (!monthsMap.has(month)) monthsMap.set(month, []);
    monthsMap.get(month)!.push(daily);
  }

  const months = Array.from(monthsMap.keys()).sort();

  // 分离已缓存和需要处理的月份
  const toProcess: Array<{ month: string; dailies: DailySummary[] }> = [];
  const cached: MonthlySummary[] = [];

  for (const month of months) {
    if (checkpoint.hasMonthlySummary(month)) {
      const existing = await checkpoint.loadMonthlySummary(month);
      if (existing) {
        cached.push(existing);
        continue;
      }
    }
    toProcess.push({ month, dailies: monthsMap.get(month)! });
  }

  logger.info(
    `📦 月度缓存命中: ${cached.length}/${months.length}, 需处理: ${toProcess.length}`
  );

  // 并发处理所有未缓存的月份
  const newSummaries: MonthlySummary[] = [];
  const errors: Array<{ month: string; error: string }> = [];
  let completed = cached.length;

  const results = await Promise.allSettled(
    toProcess.map(async ({ month, dailies }) => {
      try {
        const summary = await processMonthSummary(month, dailies);
        completed++;
        const progress = 60 + Math.round((completed / months.length) * 25);
        await checkpoint.updateProgress(
          "monthly_summarizer",
          progress,
          `Processed ${month} (${completed}/${months.length})`
        );
        return { success: true as const, summary };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error(`❌ Failed to process ${month}: ${errMsg}`);
        return { success: false as const, month, error: errMsg };
      }
    })
  );

  // 收集结果
  for (const result of results) {
    if (result.status === "fulfilled") {
      const data = result.value;
      if (data.success) {
        newSummaries.push(data.summary);
      } else {
        errors.push({ month: data.month, error: data.error });
      }
    }
  }

  // 保存新生成的 summaries
  for (const summary of newSummaries) {
    await checkpoint.saveMonthlySummary(summary);
  }

  // 合并缓存和新生成的结果，按月份排序
  const monthlySummaries = [...cached, ...newSummaries].sort((a, b) =>
    a.month.localeCompare(b.month)
  );

  if (errors.length > 0) {
    logger.warn(`⚠️  ${errors.length} months failed to process`);
  }

  return { monthlySummaries, progress: 85, currentStep: "monthly_summarizer" };
}

/**
 * Yearly Summarizer Node - Generate final year-end summary
 */
async function yearlySummarizerNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  const { year, monthlySummaries, selectedRepos, authorPattern } = state;
  const checkpoint = CheckpointManager.getInstance(year);
  await checkpoint.initialize(selectedRepos || [], authorPattern || "");

  await checkpoint.updateProgress(
    "yearly_summarizer",
    90,
    "Generating year-end summary..."
  );

  const result = await processYearEndSummary(year, monthlySummaries);

  await checkpoint.updateProgress(
    "yearly_summarizer",
    95,
    "Year-end summary complete"
  );

  return {
    result: {
      content: result.overview,
      type: "yearly",
    },
    progress: 95,
    currentStep: "yearly_summarizer",
  };
}

// Node name type for type-safe graph construction
type NodeName =
  | "collect_data"
  | "daily_summarizer"
  | "weekly_summarizer"
  | "monthly_summarizer"
  | "yearly_summarizer"
  | "persist";

/**
 * Routing functions for conditional edges
 */
function routeAfterDaily(state: WorkflowState): NodeName {
  // daily tasks stop here
  if (state.taskType === "daily") return "persist";
  // weekly and yearly go to weekly_summarizer (year-end needs weekly data too)
  if (state.taskType === "weekly" || state.taskType === "yearly")
    return "weekly_summarizer";
  // only monthly continues directly to monthly_summarizer (skips weekly)
  return "monthly_summarizer";
}

function routeAfterWeekly(state: WorkflowState): NodeName {
  // If yearly, continue to monthly_summarizer
  if (state.taskType === "yearly") return "monthly_summarizer";
  return "persist"; // Weekly always ends after weekly_summarizer
}

function routeAfterMonthly(state: WorkflowState): NodeName {
  if (state.taskType === "monthly") return "persist";
  // Only yearly continues to yearly_summarizer
  return "yearly_summarizer";
}

/**
 * Create the unified summary workflow graph
 * Supports: daily, weekly, monthly, yearly task types
 *
 * @param checkpointer - Optional LangGraph checkpointer for state persistence and resume
 */
export async function createSummaryWorkflow(
  checkpointer?: BaseCheckpointSaver
) {
  const workflow = new StateGraph(WorkflowStateAnnotation);

  // Add nodes
  workflow.addNode("collect_data", collectDataNode);
  workflow.addNode("daily_summarizer", dailySummarizerNode);
  workflow.addNode("weekly_summarizer", weeklySummarizerNode);
  workflow.addNode("monthly_summarizer", monthlySummarizerNode);
  workflow.addNode("yearly_summarizer", yearlySummarizerNode);
  workflow.addNode("persist", persistNode);

  // Type-safe edge helper to work around LangGraph's type inference limitations
  // LangGraph's StateGraph types don't track dynamically added nodes
  const addEdge = (
    from: typeof START | NodeName,
    to: typeof END | NodeName
  ) => {
    (workflow.addEdge as Function)(from, to);
  };

  const addConditionalEdges = (
    source: NodeName,
    router: (state: WorkflowState) => string,
    destinations: NodeName[]
  ) => {
    (workflow.addConditionalEdges as Function)(source, router, destinations);
  };

  // Define edges
  addEdge(START, "collect_data");
  addEdge("collect_data", "daily_summarizer");

  // Conditional routing based on task type
  addConditionalEdges("daily_summarizer", routeAfterDaily, [
    "persist",
    "weekly_summarizer",
    "monthly_summarizer",
  ]);
  addConditionalEdges("weekly_summarizer", routeAfterWeekly, [
    "persist",
    "monthly_summarizer",
  ]);
  addConditionalEdges("monthly_summarizer", routeAfterMonthly, [
    "persist",
    "yearly_summarizer",
  ]);

  addEdge("yearly_summarizer", "persist");
  addEdge("persist", END);

  // Compile with optional checkpointer for state persistence
  return workflow.compile(checkpointer ? { checkpointer } : undefined);
}

// Keep backward compatibility with old name
export const createWorkflowGraph = createSummaryWorkflow;

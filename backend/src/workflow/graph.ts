import { StateGraph, END, START, Send } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { WorkflowStateAnnotation, WorkflowState } from "./state";
import {
  collectDataNode,
  weeklySummarizerNode,
  persistNode,
} from "./nodes/index";
import { processDailySummary } from "./nodes/daily-summarizer";
import { processMonthSummary } from "./nodes/monthly-summarizer";
import { processYearEndSummary } from "./nodes/year-end-summarizer";

import { SummaryStore } from "../lib/summary-store";
import type {
  DailySummary,
  MonthlySummary,
  DailyCommitData,
} from "../lib/types";
import logger from "../lib/logger";

/**
 * Setup Node: Unified initialization for the workflow
 * Initializes SummaryStore and sets initial progress
 *
 * Pure function: Only modifies state, no side effects
 */
async function setupNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  const { year, selectedRepos, authorPattern } = state;

  logger.info("🚀 Initializing workflow...");

  // Initialize SummaryStore once for the entire workflow
  const checkpoint = SummaryStore.getInstance(year);
  await checkpoint.initialize(selectedRepos || [], authorPattern || "");

  return {
    status: "running",
    progress: 5,
    currentStep: "setup",
  };
}

/**
 * Fan-out node: Prepares data for parallel processing
 * Separates cached and uncached commits, stores pending ones in state
 *
 * Pure function: Only modifies state, no side effects
 */
async function fanOutDailyNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  const { rawCommits, year, selectedRepos, authorPattern } = state;
  const checkpoint = SummaryStore.getInstance(year);
  await checkpoint.initialize(selectedRepos || [], authorPattern || "");

  const commits = rawCommits || [];
  const cached: DailySummary[] = [];
  const toProcess: DailyCommitData[] = [];

  // Separate cached and uncached
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
    `📦 缓存命中: ${cached.length}/${commits.length}, 需处理: ${toProcess.length}`
  );

  // Store pending commits in rawCommits for the router to pick up
  // and cached summaries in dailySummaries
  return {
    rawCommits: toProcess, // Override with only pending ones
    dailySummaries: cached, // Add cached ones
    progress: 30,
    currentStep: "fan_out_daily",
  };
}

/**
 * Router function for conditional edge after fan_out_daily
 * Returns Send[] to process each pending commit in parallel, or routes to next step
 */
function routeFanOutDaily(
  state: WorkflowState
): NodeName | Send<"process_single_daily", Partial<WorkflowState>>[] {
  const { rawCommits, taskType } = state;
  const pendingCommits = rawCommits || [];

  // If no pending commits, route based on task type
  if (pendingCommits.length === 0) {
    if (taskType === "daily") return "persist";
    if (taskType === "weekly" || taskType === "yearly")
      return "weekly_summarizer";
    return "monthly_summarizer";
  }

  // Fan-out: return Send[] for parallel processing
  return pendingCommits.map(
    (commit) =>
      new Send("process_single_daily", {
        ...state,
        currentDailyCommit: commit,
        rawCommits: [], // Clear to avoid confusion
      })
  );
}

/**
 * Process a single daily commit - called in parallel via Send API
 *
 * Pure function: Only modifies state, no side effects
 */

async function processSingleDailyNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  const { currentDailyCommit, year, selectedRepos, authorPattern } = state;

  if (!currentDailyCommit) {
    logger.warn("processSingleDailyNode called without currentDailyCommit");
    return {};
  }

  const checkpoint = SummaryStore.getInstance(year);
  await checkpoint.initialize(selectedRepos || [], authorPattern || "");

  try {
    const summary = await processDailySummary(currentDailyCommit);
    await checkpoint.saveDailySummary(summary);

    logger.info(
      `✅ Processed ${currentDailyCommit.date} - ${currentDailyCommit.repo}`
    );

    // Return single summary - will be aggregated by reducer
    return {
      dailySummaries: [summary],
      progress: 60,
      currentStep: "process_single_daily",
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(`❌ Failed to process ${currentDailyCommit.date}: ${errMsg}`);
    return {};
  }
}

/**
 * Monthly Summarizer Node - Aggregate daily summaries into monthly reports (concurrent)
 *
 * Pure function: Only modifies state, no side effects
 */
async function monthlySummarizerNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  const { dailySummaries, year, selectedRepos, authorPattern } = state;
  const checkpoint = SummaryStore.getInstance(year);
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

  const results = await Promise.allSettled(
    toProcess.map(async ({ month, dailies }) => {
      try {
        const summary = await processMonthSummary(month, dailies);
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
 *
 * Pure function: Only modifies state, no side effects
 */
async function yearlySummarizerNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  const { year, monthlySummaries, selectedRepos, authorPattern } = state;
  const checkpoint = SummaryStore.getInstance(year);
  await checkpoint.initialize(selectedRepos || [], authorPattern || "");

  logger.info("🎄 Generating year-end summary...");

  const result = await processYearEndSummary(year, monthlySummaries);

  logger.info("✅ Year-end summary complete");

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
  | "setup"
  | "collect_data"
  | "fan_out_daily"
  | "process_single_daily"
  | "weekly_summarizer"
  | "monthly_summarizer"
  | "yearly_summarizer"
  | "persist";

/**
 * Routing functions for conditional edges
 */
function routeAfterSingleDaily(state: WorkflowState): NodeName {
  // After processing single daily, route based on task type
  if (state.taskType === "daily") return "persist";
  if (state.taskType === "weekly" || state.taskType === "yearly")
    return "weekly_summarizer";
  return "monthly_summarizer";
}

function routeAfterWeekly(state: WorkflowState): NodeName {
  if (state.taskType === "yearly") return "monthly_summarizer";
  return "persist";
}

function routeAfterMonthly(state: WorkflowState): NodeName {
  if (state.taskType === "monthly") return "persist";
  return "yearly_summarizer";
}

/**
 * Create the unified summary workflow graph
 * Supports: daily, weekly, monthly, yearly task types
 *
 * Uses Send API for parallel daily processing (fan-out/fan-in pattern)
 *
 * @param checkpointer - Optional LangGraph checkpointer for state persistence and resume
 */
export async function createSummaryWorkflow(
  checkpointer?: BaseCheckpointSaver
) {
  const workflow = new StateGraph(WorkflowStateAnnotation);

  // Add nodes
  workflow.addNode("setup", setupNode);
  workflow.addNode("collect_data", collectDataNode);
  workflow.addNode("fan_out_daily", fanOutDailyNode);
  workflow.addNode("process_single_daily", processSingleDailyNode);
  workflow.addNode("weekly_summarizer", weeklySummarizerNode);
  workflow.addNode("monthly_summarizer", monthlySummarizerNode);
  workflow.addNode("yearly_summarizer", yearlySummarizerNode);
  workflow.addNode("persist", persistNode);

  // Type-safe edge helper to work around LangGraph's type inference limitations
  const addEdge = (
    from: typeof START | NodeName,
    to: typeof END | NodeName
  ) => {
    (workflow.addEdge as Function)(from, to);
  };

  // Define edges
  // START -> setup -> collect_data -> fan_out_daily
  addEdge(START, "setup");
  addEdge("setup", "collect_data");
  addEdge("collect_data", "fan_out_daily");

  // fan_out_daily -> routeFanOutDaily returns Send[] or next node
  // This is where the parallel fan-out happens
  (workflow.addConditionalEdges as Function)(
    "fan_out_daily",
    routeFanOutDaily,
    [
      "process_single_daily",
      "persist",
      "weekly_summarizer",
      "monthly_summarizer",
    ]
  );

  // process_single_daily -> routing based on task type
  (workflow.addConditionalEdges as Function)(
    "process_single_daily",
    routeAfterSingleDaily,
    ["persist", "weekly_summarizer", "monthly_summarizer"]
  );

  (workflow.addConditionalEdges as Function)(
    "weekly_summarizer",
    routeAfterWeekly,
    ["persist", "monthly_summarizer"]
  );
  (workflow.addConditionalEdges as Function)(
    "monthly_summarizer",
    routeAfterMonthly,
    ["persist", "yearly_summarizer"]
  );

  addEdge("yearly_summarizer", "persist");
  addEdge("persist", END);

  // Compile with optional checkpointer for state persistence
  return workflow.compile(checkpointer ? { checkpointer } : undefined);
}

// Keep backward compatibility with old name
export const createWorkflowGraph = createSummaryWorkflow;

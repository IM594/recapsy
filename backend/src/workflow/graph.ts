import { StateGraph, END, START, Send } from "@langchain/langgraph";
import { WorkflowStateAnnotation, WorkflowState } from "./state";
import { collectDataNode, persistNode } from "./nodes/index";
import { processDailySummary } from "./nodes/daily-summarizer";
import { processWeeklySummary } from "./nodes/weekly-summarizer";
import { processMonthSummary } from "./nodes/monthly-summarizer";
import { processYearEndSummary } from "./nodes/year-end-summarizer";

import { SummaryStore } from "../lib/summary-store";
import type {
  DailySummary,
  MonthlySummary,
  DailyCommitData,
  WeeklySummary,
} from "../lib/types";
import logger from "../lib/logger";
import { WorkflowRunner } from "../lib/workflow-runner";

// Helper functions for date calculations
function getWeekStart(dateStr: string): string {
  const d = new Date(dateStr);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  return monday.toISOString().slice(0, 10);
}

function getWeekEnd(weekStart: string): string {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + 6);
  return d.toISOString().slice(0, 10);
}

/**
 * Setup Node
 */
async function setupNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  const { year, selectedRepos, authorPattern } = state;
  const runner = WorkflowRunner.getInstance(year);

  logger.info("🚀 Initializing workflow...");
  runner.updateProgress("setup", 100, "Workflow initialized");

  const checkpoint = SummaryStore.getInstance(year);
  await checkpoint.initialize(selectedRepos || [], authorPattern || "");
  return { status: "running", currentStep: "setup" };
}

// ==========================================
// DAILY PHASE
// ==========================================

async function fanOutDailyNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  const { rawCommits, year, selectedRepos, authorPattern } = state;
  const checkpoint = SummaryStore.getInstance(year);
  await checkpoint.initialize(selectedRepos || [], authorPattern || "");

  const commits = rawCommits || [];
  const cached: DailySummary[] = [];
  const toProcess: DailyCommitData[] = [];

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
    `📦 Daily cache hit: ${cached.length}/${commits.length}, To Process: ${toProcess.length}`
  );

  // Reset counter for this phase
  const runner = WorkflowRunner.getInstance(year);
  runner.resetProgressCounter("process_single_daily");
  runner.updateProgress(
    "fan_out_daily",
    0,
    `Starting daily processing (${toProcess.length} items)`
  );

  return {
    rawCommits: toProcess,
    dailySummaries: cached,
    currentStep: "fan_out_daily",
  };
}

function routeFanOutDaily(
  state: WorkflowState
): typeof END | Send<"process_single_daily", Partial<WorkflowState>>[] {
  const { rawCommits } = state;
  const pendingCommits = rawCommits || [];

  if (pendingCommits.length === 0) {
    return END;
  }

  return pendingCommits.map(
    (commit, i) =>
      new Send("process_single_daily", {
        ...state,
        currentDailyCommit: commit,
        dailyExecutionMetadata: {
          index: i,
          total: pendingCommits.length,
        },
        rawCommits: [],
      })
  );
}

async function processSingleDailyNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  const {
    currentDailyCommit,
    year,
    selectedRepos,
    authorPattern,
    dailyExecutionMetadata,
  } = state;
  if (!currentDailyCommit) return {};

  const checkpoint = SummaryStore.getInstance(year);
  const runner = WorkflowRunner.getInstance(year);
  await checkpoint.initialize(selectedRepos || [], authorPattern || "");

  const total = dailyExecutionMetadata?.total || 1;

  try {
    const summary = await processDailySummary(currentDailyCommit);
    await checkpoint.saveDailySummary(summary);

    runner.incrementProgress(
      "process_single_daily",
      total,
      `Processed ${currentDailyCommit.date}`
    );

    return { dailySummaries: [summary], currentStep: "process_single_daily" };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(`❌ Failed to process ${currentDailyCommit.date}: ${errMsg}`);
    runner.incrementProgress(
      "process_single_daily",
      total,
      `Failed ${currentDailyCommit.date}`
    );
    return {};
  }
}

// Build Daily Subgraph
const dailyFlow = new StateGraph(WorkflowStateAnnotation)
  .addNode("fan_out_daily", fanOutDailyNode)
  .addNode("process_single_daily", processSingleDailyNode)
  .addEdge(START, "fan_out_daily")
  .addConditionalEdges("fan_out_daily", routeFanOutDaily, [
    "process_single_daily",
    END,
  ])
  // process_single_daily creates NO routing edge, effectively ending that branch (Reduce)
  // But wait, parallel branches in LangGraph need to end?
  // Yes, they eventually hit END.
  // We need to add edge process_single_daily -> END ??
  // No, if we don't add edge, it's a dead end?
  // LangGraph documentation: "If a node has no outgoing edges, it is an end node".
  // So we don't need to add explicit edge to END if we don't want to.
  // But let's be explicit if possible.
  // Actually, for Send(), the branches are separate. When they finish, they merge state.
  // So we assume it finishes.
  .compile();

// ==========================================
// WEEKLY PHASE
// ==========================================

async function fanOutWeeklyNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  const { dailySummaries, year, selectedRepos, authorPattern } = state;
  const checkpoint = SummaryStore.getInstance(year);
  await checkpoint.initialize(selectedRepos || [], authorPattern || "");

  // Reset counter for this phase
  const runner = WorkflowRunner.getInstance(year);
  runner.resetProgressCounter("process_single_week");

  if (!dailySummaries || dailySummaries.length === 0) {
    runner.updateProgress("fan_out_weekly", 100, "No weekly tasks to process");
    return {
      pendingWeeklyTasks: [],
      currentStep: "fan_out_weekly",
    };
  }

  const weeklyGroups = new Map<string, DailySummary[]>();
  for (const daily of dailySummaries) {
    const weekStart = getWeekStart(daily.date);
    if (!weeklyGroups.has(weekStart)) weeklyGroups.set(weekStart, []);
    weeklyGroups.get(weekStart)!.push(daily);
  }

  const weeks = Array.from(weeklyGroups.keys()).sort();
  const cached: WeeklySummary[] = [];
  const toProcess: Array<{ weekStart: string; dailies: DailySummary[] }> = [];

  for (const weekStart of weeks) {
    if (checkpoint.hasWeeklySummary(weekStart)) {
      const existing = await checkpoint.loadWeeklySummary(weekStart);
      if (existing) {
        cached.push(existing);
        continue;
      }
    }
    toProcess.push({ weekStart, dailies: weeklyGroups.get(weekStart)! });
  }

  logger.info(
    `📦 Weekly cache hit: ${cached.length}/${weeks.length}, To Process: ${toProcess.length}`
  );

  runner.updateProgress(
    "fan_out_weekly",
    0,
    `Starting weekly processing (${toProcess.length} weeks)`
  );

  return {
    pendingWeeklyTasks: toProcess,
    weeklySummaries: cached,
    currentStep: "fan_out_weekly",
  };
}

function routeFanOutWeekly(
  state: WorkflowState
): typeof END | Send<"process_single_week", Partial<WorkflowState>>[] {
  const { pendingWeeklyTasks } = state;
  const tasks = pendingWeeklyTasks || [];
  if (tasks.length === 0) return END;

  return tasks.map(
    (task, i) =>
      new Send("process_single_week", {
        ...state,
        currentWeeklyTask: task,
        weeklyExecutionMetadata: { index: i, total: tasks.length },
        pendingWeeklyTasks: [],
      })
  );
}

async function processSingleWeeklyNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  const {
    currentWeeklyTask,
    year,
    selectedRepos,
    authorPattern,
    weeklyExecutionMetadata,
  } = state;
  if (!currentWeeklyTask) return {};

  const checkpoint = SummaryStore.getInstance(year);
  const runner = WorkflowRunner.getInstance(year);
  await checkpoint.initialize(selectedRepos || [], authorPattern || "");
  const total = weeklyExecutionMetadata?.total || 1;
  const { weekStart, dailies } = currentWeeklyTask;

  try {
    const summary = await processWeeklySummary(
      weekStart,
      getWeekEnd(weekStart),
      dailies
    );
    await checkpoint.saveWeeklySummary(summary);
    runner.incrementProgress(
      "process_single_week",
      total,
      `Processed Week ${weekStart}`
    );
    return { weeklySummaries: [summary], currentStep: "process_single_week" };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(`❌ Failed to process week ${weekStart}: ${errMsg}`);
    runner.incrementProgress(
      "process_single_week",
      total,
      `Failed Week ${weekStart}`
    );
    return {};
  }
}

const weeklyFlow = new StateGraph(WorkflowStateAnnotation)
  .addNode("fan_out_weekly", fanOutWeeklyNode)
  .addNode("process_single_week", processSingleWeeklyNode)
  .addEdge(START, "fan_out_weekly")
  .addConditionalEdges("fan_out_weekly", routeFanOutWeekly, [
    "process_single_week",
    END,
  ])
  .compile();

// ==========================================
// MONTHLY PHASE
// ==========================================

async function fanOutMonthlyNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  const { dailySummaries, year, selectedRepos, authorPattern } = state;
  const checkpoint = SummaryStore.getInstance(year);
  await checkpoint.initialize(selectedRepos || [], authorPattern || "");

  const monthsMap = new Map<string, DailySummary[]>();
  for (const daily of dailySummaries || []) {
    const month = daily.date.substring(0, 7);
    if (!monthsMap.has(month)) monthsMap.set(month, []);
    monthsMap.get(month)!.push(daily);
  }

  const months = Array.from(monthsMap.keys()).sort();
  const cached: MonthlySummary[] = [];
  const toProcess: Array<{ month: string; dailies: DailySummary[] }> = [];

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
    `📦 Monthly cache hit: ${cached.length}/${months.length}, To Process: ${toProcess.length}`
  );

  // Reset counter for this phase
  const runner = WorkflowRunner.getInstance(year);
  runner.resetProgressCounter("process_single_month");
  runner.updateProgress(
    "fan_out_monthly",
    0,
    `Starting monthly processing (${toProcess.length} months)`
  );

  return {
    pendingMonthlyTasks: toProcess,
    monthlySummaries: cached,
    currentStep: "fan_out_monthly",
  };
}

function routeFanOutMonthly(
  state: WorkflowState
): typeof END | Send<"process_single_month", Partial<WorkflowState>>[] {
  const { pendingMonthlyTasks } = state;
  const tasks = pendingMonthlyTasks || [];
  if (tasks.length === 0) return END;

  return tasks.map(
    (task, i) =>
      new Send("process_single_month", {
        ...state,
        currentMonthlyTask: task,
        monthlyExecutionMetadata: { index: i, total: tasks.length },
        pendingMonthlyTasks: [],
      })
  );
}

async function processSingleMonthlyNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  const {
    currentMonthlyTask,
    year,
    selectedRepos,
    authorPattern,
    monthlyExecutionMetadata,
  } = state;
  if (!currentMonthlyTask) return {};

  const checkpoint = SummaryStore.getInstance(year);
  const runner = WorkflowRunner.getInstance(year);
  await checkpoint.initialize(selectedRepos || [], authorPattern || "");
  const total = monthlyExecutionMetadata?.total || 1;
  const { month, dailies } = currentMonthlyTask;

  try {
    const summary = await processMonthSummary(month, dailies);
    await checkpoint.saveMonthlySummary(summary);
    runner.incrementProgress(
      "process_single_month",
      total,
      `Processed Month ${month}`
    );
    return { monthlySummaries: [summary], currentStep: "process_single_month" };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(`❌ Failed to process month ${month}: ${errMsg}`);
    runner.incrementProgress(
      "process_single_month",
      total,
      `Failed Month ${month}`
    );
    return {};
  }
}

const monthlyFlow = new StateGraph(WorkflowStateAnnotation)
  .addNode("fan_out_monthly", fanOutMonthlyNode)
  .addNode("process_single_month", processSingleMonthlyNode)
  .addEdge(START, "fan_out_monthly")
  .addConditionalEdges("fan_out_monthly", routeFanOutMonthly, [
    "process_single_month",
    END,
  ])
  .compile();

// ==========================================
// YEARLY PHASE
// ==========================================

async function yearlySummarizerNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  const {
    year,
    monthlySummaries,
    weeklySummaries,
    selectedRepos,
    authorPattern,
  } = state;
  const checkpoint = SummaryStore.getInstance(year);
  await checkpoint.initialize(selectedRepos || [], authorPattern || "");

  const runner = WorkflowRunner.getInstance(year);

  logger.info("🎄 Generating year-end summary...");
  runner.updateProgress(
    "yearly_summarizer",
    10,
    "Generating year-end summary..."
  );

  const result = await processYearEndSummary(
    year,
    monthlySummaries,
    weeklySummaries
  );

  logger.info("✅ Year-end summary complete");
  runner.updateProgress("yearly_summarizer", 100, "Year-end summary complete");

  return {
    result: { content: result.overview, type: "yearly" },
    currentStep: "yearly_summarizer",
  };
}

// ==========================================
// MAIN WORKFLOW
// ==========================================

// Main Graph Routers
function routeAfterDailyPhase(
  state: WorkflowState
): "persist" | "weekly_phase" {
  // If task is daily, we stop. Else we go to weekly.
  // Note: "daily" task might imply "process valid days".
  // If we only wanted to do daily, we exit.
  if (state.taskType === "daily") return "persist";
  return "weekly_phase";
}

function routeAfterWeeklyPhase(
  state: WorkflowState
): "persist" | "monthly_phase" {
  if (state.taskType === "weekly") return "persist";
  return "monthly_phase";
}

function routeAfterMonthlyPhase(
  state: WorkflowState
): "persist" | "yearly_summarizer" {
  if (state.taskType === "monthly") return "persist";
  return "yearly_summarizer";
}

export async function createSummaryWorkflow() {
  const workflow = new StateGraph(WorkflowStateAnnotation)
    .addNode("setup", setupNode)
    .addNode("collect_data", collectDataNode)
    // Add Subgraphs as Nodes
    .addNode("daily_phase", dailyFlow)
    .addNode("weekly_phase", weeklyFlow)
    .addNode("monthly_phase", monthlyFlow)
    .addNode("yearly_summarizer", yearlySummarizerNode)
    .addNode("persist", persistNode)

    // Edges
    .addEdge(START, "setup")
    .addEdge("setup", "collect_data")
    .addEdge("collect_data", "daily_phase")

    // Routers between phases
    .addConditionalEdges("daily_phase", routeAfterDailyPhase, [
      "persist",
      "weekly_phase",
    ])
    .addConditionalEdges("weekly_phase", routeAfterWeeklyPhase, [
      "persist",
      "monthly_phase",
    ])
    .addConditionalEdges("monthly_phase", routeAfterMonthlyPhase, [
      "persist",
      "yearly_summarizer",
    ])

    .addEdge("yearly_summarizer", "persist")
    .addEdge("persist", END);

  return workflow.compile();
}

// Backward compatibility
export const createWorkflowGraph = createSummaryWorkflow;

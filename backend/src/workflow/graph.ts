import { StateGraph, END, START } from "@langchain/langgraph";
import { WorkflowStateAnnotation, WorkflowState } from "./state";
import {
  collectDataNode,
  weeklySummarizerNode,
  persistNode,
} from "./nodes/index";
import { processDailySummary } from "./nodes/daily-summarizer";
import { processMonthSummary } from "./nodes/monthly-summarizer";
import { processYearEndSummary } from "./nodes/year-end-summarizer";
import { CheckpointManager } from "../lib/checkpoint";
import type { DailySummary, MonthlySummary } from "../lib/types";

/**
 * Daily Summarizer Node - Process all collected daily data
 */
async function dailySummarizerNode(
  state: WorkflowState
): Promise<Partial<WorkflowState>> {
  const { rawCommits, year, selectedRepos, authorPattern } = state;
  const checkpoint = CheckpointManager.getInstance(year);
  await checkpoint.initialize(selectedRepos || [], authorPattern || "");

  const dailySummaries: DailySummary[] = [];
  const commits = rawCommits || [];
  const total = commits.length;

  for (let i = 0; i < commits.length; i++) {
    const dayData = commits[i];
    const key = `${dayData.date}-${dayData.repo}`;

    // Skip if already processed
    if (checkpoint.hasDailySummary(dayData.date, dayData.repo)) {
      const existing = await checkpoint.loadDailySummary(
        dayData.date,
        dayData.repo
      );
      if (existing) {
        dailySummaries.push(existing);
        continue;
      }
    }

    const summary = await processDailySummary(dayData);
    await checkpoint.saveDailySummary(summary);
    dailySummaries.push(summary);

    // Update progress (20-60%)
    const progress = 20 + Math.round((i / total) * 40);
    await checkpoint.updateProgress(
      "daily_summarizer",
      progress,
      `Processed ${dayData.date} (${dayData.repo})`
    );
  }

  return { dailySummaries, progress: 60, currentStep: "daily_summarizer" };
}

/**
 * Monthly Summarizer Node - Aggregate daily summaries into monthly reports
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

  const monthlySummaries: MonthlySummary[] = [];
  const months = Array.from(monthsMap.keys()).sort();

  for (let i = 0; i < months.length; i++) {
    const month = months[i];

    // Skip if already processed
    if (checkpoint.hasMonthlySummary(month)) {
      const existing = await checkpoint.loadMonthlySummary(month);
      if (existing) {
        monthlySummaries.push(existing);
        continue;
      }
    }

    const monthDailies = monthsMap.get(month)!;
    const summary = await processMonthSummary(month, monthDailies);
    await checkpoint.saveMonthlySummary(summary);
    monthlySummaries.push(summary);

    // Update progress (60-85%)
    const progress = 60 + Math.round((i / months.length) * 25);
    await checkpoint.updateProgress(
      "monthly_summarizer",
      progress,
      `Processed ${month}`
    );
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

/**
 * Routing functions for conditional edges
 */
function routeAfterDaily(state: WorkflowState): string {
  // daily tasks stop here
  if (state.taskType === "daily") return "persist";
  // weekly goes to weekly_summarizer
  if (state.taskType === "weekly") return "weekly_summarizer";
  // monthly and yearly continue to monthly_summarizer
  return "monthly_summarizer";
}

function routeAfterWeekly(state: WorkflowState): string {
  return "persist"; // Weekly always ends after weekly_summarizer
}

function routeAfterMonthly(state: WorkflowState): string {
  if (state.taskType === "monthly") return "persist";
  // Only yearly continues to yearly_summarizer
  return "yearly_summarizer";
}

/**
 * Create the unified summary workflow graph
 * Supports: daily, weekly, monthly, yearly task types
 */
export function createSummaryWorkflow() {
  const workflow = new StateGraph(WorkflowStateAnnotation);

  // Add nodes
  workflow.addNode("collect_data", collectDataNode);
  workflow.addNode("daily_summarizer", dailySummarizerNode);
  workflow.addNode("weekly_summarizer", weeklySummarizerNode);
  workflow.addNode("monthly_summarizer", monthlySummarizerNode);
  workflow.addNode("yearly_summarizer", yearlySummarizerNode);
  workflow.addNode("persist", persistNode);

  // Define edges (use type assertions to bypass LangGraph's strict typing)
  workflow.addEdge(START, "collect_data" as any);
  workflow.addEdge("collect_data" as any, "daily_summarizer" as any);

  // Conditional routing based on task type
  workflow.addConditionalEdges(
    "daily_summarizer" as any,
    routeAfterDaily as any
  );
  workflow.addConditionalEdges(
    "weekly_summarizer" as any,
    routeAfterWeekly as any
  );
  workflow.addConditionalEdges(
    "monthly_summarizer" as any,
    routeAfterMonthly as any
  );

  workflow.addEdge("yearly_summarizer" as any, "persist" as any);
  workflow.addEdge("persist" as any, END);

  return workflow.compile();
}

// Keep backward compatibility with old name
export const createWorkflowGraph = createSummaryWorkflow;

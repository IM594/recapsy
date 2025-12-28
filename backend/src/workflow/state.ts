import { Annotation } from "@langchain/langgraph";
import type {
  DailyCommitData,
  DailySummary,
  WeeklySummary,
  MonthlySummary,
} from "../lib/types";

/**
 * Unified Workflow State for all summary generation tasks
 */
export const WorkflowStateAnnotation = Annotation.Root({
  // === Input Parameters ===

  // Task type determines the execution path
  taskType: Annotation<"daily" | "weekly" | "monthly" | "yearly">({
    reducer: (prev, next) => next || prev || "daily",
  }),

  // Year for data organization
  year: Annotation<number>({
    reducer: (prev, next) => next || prev || new Date().getFullYear(),
  }),

  // Repository paths to collect from
  selectedRepos: Annotation<string[]>({
    reducer: (prev, next) => next || prev || [],
  }),

  // Author pattern for filtering commits
  authorPattern: Annotation<string>({
    reducer: (prev, next) => next ?? prev ?? "",
  }),

  // Date range
  since: Annotation<string>({
    reducer: (prev, next) => next || prev || "",
  }),

  until: Annotation<string>({
    reducer: (prev, next) => next || prev || "",
  }),

  // Specific targets (for single day/month generation)
  targetDate: Annotation<string>({
    reducer: (prev, next) => next ?? prev ?? "",
  }),

  targetMonth: Annotation<string>({
    reducer: (prev, next) => next ?? prev ?? "",
  }),

  // === Intermediate Data ===

  // Raw commit data collected from git (per date-repo)
  rawCommits: Annotation<DailyCommitData[]>({
    reducer: (prev, next) => next || prev || [],
  }),

  // Current daily commit being processed (for Send API parallel execution)
  currentDailyCommit: Annotation<DailyCommitData | null>({
    reducer: (prev, next) => next ?? prev ?? null,
  }),

  // Progress metadata for parallel daily execution
  dailyExecutionMetadata: Annotation<{ index: number; total: number } | null>({
    reducer: (prev, next) => next ?? prev ?? null,
  }),

  // Pending weekly tasks (for fan-out routing)
  pendingWeeklyTasks: Annotation<
    { weekStart: string; dailies: DailySummary[] }[]
  >({
    reducer: (prev, next) => next || prev || [],
  }),

  // Pending monthly tasks
  pendingMonthlyTasks: Annotation<{ month: string; dailies: DailySummary[] }[]>(
    {
      reducer: (prev, next) => next || prev || [],
    }
  ),

  // Current weekly task (weekStart + dailies)
  currentWeeklyTask: Annotation<{
    weekStart: string;
    dailies: DailySummary[];
  } | null>({
    reducer: (prev, next) => next ?? prev ?? null,
  }),

  // Progress metadata for parallel weekly execution
  weeklyExecutionMetadata: Annotation<{ index: number; total: number } | null>({
    reducer: (prev, next) => next ?? prev ?? null,
  }),

  // Current monthly task (month + dailies)
  currentMonthlyTask: Annotation<{
    month: string;
    dailies: DailySummary[];
  } | null>({
    reducer: (prev, next) => next ?? prev ?? null,
  }),

  // Progress metadata for parallel monthly execution
  monthlyExecutionMetadata: Annotation<{ index: number; total: number } | null>(
    {
      reducer: (prev, next) => next ?? prev ?? null,
    }
  ),

  // Generated daily summaries (aggregated from parallel Send executions)
  dailySummaries: Annotation<DailySummary[]>({
    reducer: (prev, next) => [...(prev || []), ...(next || [])],
  }),

  // Generated weekly summaries
  weeklySummaries: Annotation<WeeklySummary[]>({
    reducer: (prev, next) => [...(prev || []), ...(next || [])],
  }),

  // Generated monthly summaries
  monthlySummaries: Annotation<MonthlySummary[]>({
    reducer: (prev, next) => [...(prev || []), ...(next || [])],
  }),

  // === Output ===

  // Final result content
  result: Annotation<{
    content: string;
    type: string;
  } | null>({
    reducer: (prev, next) => next ?? prev ?? null,
  }),

  // === Runtime State (for SSE progress) ===

  status: Annotation<"idle" | "running" | "complete" | "error">({
    reducer: (prev, next) => next || prev || "idle",
  }),

  currentStep: Annotation<string>({
    reducer: (prev, next) => next ?? prev ?? "",
  }),

  progress: Annotation<number>({
    reducer: (prev, next) => next ?? prev ?? 0,
  }),

  error: Annotation<string>({
    reducer: (prev, next) => next ?? prev ?? "",
  }),
});

export type WorkflowState = typeof WorkflowStateAnnotation.State;

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

  // Generated daily summaries
  dailySummaries: Annotation<DailySummary[]>({
    reducer: (prev, next) => next || prev || [],
  }),

  // Generated weekly summaries
  weeklySummaries: Annotation<WeeklySummary[]>({
    reducer: (prev, next) => next || prev || [],
  }),

  // Generated monthly summaries
  monthlySummaries: Annotation<MonthlySummary[]>({
    reducer: (prev, next) => next || prev || [],
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

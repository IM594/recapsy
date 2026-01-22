import { WORKFLOW_STEP_IDS } from "@recaply/shared";

export type YearEndProcessStepId =
  | "collect"
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly";

/**
 * UI mapping: workflow node id -> YearEndGenerator step id
 * Keep this as the single source of truth for progress rendering.
 */
export const YEAR_END_STEP_BY_WORKFLOW_STEP: Record<string, YearEndProcessStepId> = {
  [WORKFLOW_STEP_IDS.setup]: "collect",
  [WORKFLOW_STEP_IDS.collectData]: "collect",

  // Phase nodes
  [WORKFLOW_STEP_IDS.dailyPhase]: "daily",
  [WORKFLOW_STEP_IDS.weeklyPhase]: "weekly",
  [WORKFLOW_STEP_IDS.monthlyPhase]: "monthly",

  // Internal subgraph nodes (granular)
  [WORKFLOW_STEP_IDS.fanOutDaily]: "daily",
  [WORKFLOW_STEP_IDS.processSingleDaily]: "daily",
  [WORKFLOW_STEP_IDS.fanOutWeekly]: "weekly",
  [WORKFLOW_STEP_IDS.processSingleWeek]: "weekly",
  [WORKFLOW_STEP_IDS.fanOutMonthly]: "monthly",
  [WORKFLOW_STEP_IDS.processSingleMonth]: "monthly",

  [WORKFLOW_STEP_IDS.yearlySummarizer]: "yearly",
  [WORKFLOW_STEP_IDS.persist]: "yearly",
};


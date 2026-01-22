export const WORKFLOW_PHASES = {
  idle: "idle",
  running: "running",
  complete: "complete",
  error: "error",
} as const;

export type WorkflowPhase =
  (typeof WORKFLOW_PHASES)[keyof typeof WORKFLOW_PHASES];

export const WORKFLOW_STEP_IDS = {
  // Pre-flight / runtime
  starting: "starting",

  // Main workflow
  setup: "setup",
  collectData: "collect_data",
  dailyPhase: "daily_phase",
  weeklyPhase: "weekly_phase",
  monthlyPhase: "monthly_phase",
  yearlySummarizer: "yearly_summarizer",
  persist: "persist",

  // Internal nodes (subgraph)
  fanOutDaily: "fan_out_daily",
  processSingleDaily: "process_single_daily",
  fanOutWeekly: "fan_out_weekly",
  processSingleWeek: "process_single_week",
  fanOutMonthly: "fan_out_monthly",
  processSingleMonth: "process_single_month",

  // Legacy / node-local
  weeklySummarizer: "weekly_summarizer",
} as const;

export type WorkflowStepId =
  (typeof WORKFLOW_STEP_IDS)[keyof typeof WORKFLOW_STEP_IDS];

export const WORKFLOW_STEP_ID_LIST = Object.values(WORKFLOW_STEP_IDS) as WorkflowStepId[];

export function isWorkflowStepId(value: unknown): value is WorkflowStepId {
  return typeof value === "string" && (WORKFLOW_STEP_ID_LIST as readonly string[]).includes(value);
}


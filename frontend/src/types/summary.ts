export type SummaryType = "daily" | "weekly" | "monthly" | "yearly";

export type SummaryPhase =
  | "idle"
  | "starting"
  | "running"
  | "complete"
  | "error";

export interface GenerationConfig {
  selectedRepos: string[];
  since: string;
  until: string;
  summaryType: SummaryType;
  year: number;
  author?: string;
}

export interface LogEntry {
  timestamp: string;
  message: string;
  type: "info" | "error" | "success";
}

export interface SummaryStatus {
  isRunning: boolean;
  phase: SummaryPhase;
  progress: number;
  currentStep: string | null;
  result?: unknown;
}

export interface SSEEvent {
  nodeId: string;
  state: {
    progress?: number;
    currentStep?: string;
    phase?: string;
    isRunning?: boolean;
    message?: string;
    result?: unknown;
    error?: string;
  };
  timestamp: number;
}

export interface DailySummaryData {
  date: string; // YYYY-MM-DD
  repo: string; // basename
  summary?: string;
  keyChanges?: string[];
  tokensUsed?: number;
}

export interface WeeklySummaryData {
  weekStart: string; // YYYY-MM-DD (Monday)
  weekEnd: string; // YYYY-MM-DD (Sunday)
  summary?: string;
  highlights?: string[];
  daysWithWork?: number;
  tokensUsed?: number;
}

export interface MonthlySummaryData {
  month: string; // YYYY-MM
  summary?: string;
  highlights?: string[];
  daysWithWork?: number;
}

export type YearlySummaryData = { content: string } | null;

export interface SummaryWorkflowResult {
  taskType?: SummaryType;
  since?: string;
  year?: number;
  dailySummaries?: Array<{ date: string; repo: string; summary: string }>;
  weeklySummaries?: Array<{ weekStart: string; summary: string }>;
  monthlySummaries?: Array<{ month: string; summary: string }>;
  content?: string;
  result?: { content?: string };
}

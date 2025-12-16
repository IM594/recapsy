/**
 * Types for Year-End Summary Feature
 */

// ============ Git Data Types ============

export interface CommitInfo {
  hash: string;
  author: string;
  authorDate: string; // ISO format
  message: string;
  files: FileChange[];
  diff?: string; // Optional diff content (may be truncated)
}

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
}

export interface DailyCommitData {
  date: string; // YYYY-MM-DD
  repo: string; // Repository name (basename)
  commits: CommitInfo[];
  stats: {
    totalCommits: number;
    totalAdditions: number;
    totalDeletions: number;
    filesChanged: number;
  };
}

// ============ Summary Types ============

export interface DailySummary {
  date: string; // YYYY-MM-DD
  repo: string; // Repository name (basename)
  summary: string;
  keyChanges: string[];
  tokensUsed?: number;
}

export interface WeeklySummary {
  weekStart: string; // YYYY-MM-DD format (Monday)
  weekEnd: string; // YYYY-MM-DD format (Sunday)
  summary: string;
  highlights: string[];
  daysWithWork: number;
  tokensUsed?: number;
}

export interface MonthlySummary {
  month: string; // YYYY-MM
  summary: string;
  highlights: string[];
  daysWithWork: number;
}

export interface YearEndSummary {
  year: number;
  overview: string;
  achievements: string[];
  technicalGrowth: string[];
  challenges: string[];
  monthlyHighlights: Record<string, string>;
}

// ============ Checkpoint Types ============

export interface YearEndCheckpoint {
  year: number;
  repos: string[];
  authorPattern: string;
  createdAt: string;
  updatedAt: string;

  // Runtime state (for SSE)
  isRunning: boolean;
  currentStep: string | null;
  progress: number; // 0-100

  // Progress tracking
  phase:
    | "idle"
    | "starting"
    | "collecting"
    | "daily_summary"
    | "weekly_summary"
    | "monthly_summary"
    | "yearly_summary"
    | "complete"
    | "error";

  // Data collection progress
  collectedDates: string[]; // Dates that have raw data collected

  // Summary progress
  dailySummariesCompleted: string[]; // Dates that have daily summaries
  weeklySummariesCompleted: string[]; // Weeks that have summaries (YYYY-MM-DD format for start date)
  monthlySummariesCompleted: string[]; // Months that have summaries (YYYY-MM)

  // Error tracking
  errors: Array<{
    date: string;
    phase: string;
    error: string;
    timestamp: string;
  }>;
}

// ============ DevTool Types ============

export type NodeName =
  | "collect_data"
  | "daily_summarizer"
  | "monthly_summarizer"
  | "yearly_summarizer";

export interface DevToolRequest {
  nodeName: NodeName;
  input: Record<string, unknown>;
}

export interface DevToolResponse {
  success: boolean;
  nodeName: NodeName;
  executionTimeMs: number;
  output?: unknown;
  error?: string;
}

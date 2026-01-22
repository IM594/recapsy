import type { SummaryType } from "@/types/summary";

export type NodeType = SummaryType;

export interface DailyInfo {
  date: string;
  repo: string;
  hasSummary: boolean;
}

export interface Structure {
  year: number;
  hasYearlySummary: boolean;
  months: {
    month: string;
    hasSummary: boolean;
    days: DailyInfo[];
  }[];
  weeks: {
    weekStart: string;
    weekEnd: string;
    hasSummary: boolean;
    title: string;
  }[];
}

export interface NavigationNode {
  type: NodeType;
  id: string; // date YYYY-MM-DD, month YYYY-MM, or year YYYY
  repo?: string;
  label: string;
}

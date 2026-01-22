import { SUMMARY_TYPES } from "@recaply/shared";
import type { SummaryType } from "./summary";

export type GenerationContext =
  | {
      type: typeof SUMMARY_TYPES.daily;
      id: string; // YYYY-MM-DD
      repo: string;
      repoOptions?: string[];
      summariesByRepo?: Record<string, string>;
    }
  | {
      type: typeof SUMMARY_TYPES.weekly;
      id: string; // weekStart YYYY-MM-DD
    }
  | {
      type: typeof SUMMARY_TYPES.monthly;
      id: string; // YYYY-MM
    }
  | {
      type: typeof SUMMARY_TYPES.yearly;
      id: string; // YYYY
    };

export interface GenerationResultState {
  year: number;
  title: string;
  summary: string;
  outputPath: string;
  context: GenerationContext;
}

export interface RegenerateRequestContext {
  type: SummaryType;
  id: string;
  year: number;
  repo?: string;
}

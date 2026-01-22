import { toDateString, toMonthString } from "@/lib/date-utils";
import { COPY } from "@/constants/copy";
import type { GenerationResultState } from "@/types/generation";
import type { SummaryType, SummaryWorkflowResult } from "@/types/summary";
import { SUMMARY_TYPES, isSummaryType as isSharedSummaryType } from "@recaply/shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseYear(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseSinceDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function asWorkflowResult(value: unknown): SummaryWorkflowResult | null {
  if (!isRecord(value)) return null;
  return value as SummaryWorkflowResult;
}

export function buildGenerationResultFromWorkflowResult(
  workflowResult: unknown,
  fallbackYear: number
): GenerationResultState | null {
  const result = asWorkflowResult(workflowResult);
  if (!result) return null;

  const year = parseYear(result.year) ?? fallbackYear;
  const taskType = isSharedSummaryType(result.taskType) ? result.taskType : undefined;
  const sinceDate = parseSinceDate(result.since);

  const inferredType: SummaryType | undefined =
    taskType ||
    (result.dailySummaries?.length ? SUMMARY_TYPES.daily : undefined) ||
    (result.weeklySummaries?.length ? SUMMARY_TYPES.weekly : undefined) ||
    (result.monthlySummaries?.length ? SUMMARY_TYPES.monthly : undefined) ||
    (result.result?.content || result.content ? SUMMARY_TYPES.yearly : undefined);

  if (!inferredType) return null;

  if (inferredType === SUMMARY_TYPES.daily) {
    if (!sinceDate) return null;
    const dailySummaries = result.dailySummaries;
    if (!dailySummaries?.length) return null;

    const targetDate = toDateString(sinceDate);
    const matches = dailySummaries.filter((d) => d.date === targetDate);
    if (matches.length === 0) return null;

    const summariesByRepo = Object.fromEntries(
      matches.map((m) => [m.repo, m.summary])
    );
    const repoOptions = matches
      .map((m) => m.repo)
      .slice()
      .sort((a, b) => a.localeCompare(b));

    const defaultRepo = repoOptions[0];
    const defaultSummary = summariesByRepo[defaultRepo] ?? "";
    if (!defaultSummary) return null;

    return {
      year,
      title: `${COPY.summaryTypes.label("daily")} (${targetDate})`,
      summary: defaultSummary,
      outputPath: "",
      context: {
        type: SUMMARY_TYPES.daily,
        id: targetDate,
        repo: defaultRepo,
        repoOptions,
        summariesByRepo,
      },
    };
  }

  if (inferredType === SUMMARY_TYPES.weekly) {
    if (!sinceDate) return null;
    const weeklySummaries = result.weeklySummaries;
    if (!weeklySummaries?.length) return null;

    const targetWeekStart = toDateString(sinceDate);
    const matched = weeklySummaries.find((w) => w.weekStart === targetWeekStart);
    if (!matched?.summary) return null;

    return {
      year,
      title: `${COPY.summaryTypes.label("weekly")} (${targetWeekStart})`,
      summary: matched.summary,
      outputPath: "",
      context: {
        type: SUMMARY_TYPES.weekly,
        id: matched.weekStart,
      },
    };
  }

  if (inferredType === SUMMARY_TYPES.monthly) {
    if (!sinceDate) return null;
    const monthlySummaries = result.monthlySummaries;
    if (!monthlySummaries?.length) return null;

    const targetMonth = toMonthString(sinceDate);
    const matched = monthlySummaries.find((m) => m.month === targetMonth);
    if (!matched?.summary) return null;

    return {
      year,
      title: `${COPY.summaryTypes.label("monthly")} (${targetMonth})`,
      summary: matched.summary,
      outputPath: "",
      context: {
        type: SUMMARY_TYPES.monthly,
        id: matched.month,
      },
    };
  }

  const content = result.result?.content || result.content;
  if (!content) return null;

  return {
    year,
    title: COPY.summaryTypes.generationPreviewTitle(SUMMARY_TYPES.yearly, year),
    summary: String(content),
    outputPath: "",
    context: {
      type: SUMMARY_TYPES.yearly,
      id: String(year),
    },
  };
}

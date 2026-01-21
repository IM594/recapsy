import { toDateString, toMonthString } from "@/lib/date-utils";
import type { GenerationResultState } from "@/types/generation";
import type { SummaryType, SummaryWorkflowResult } from "@/types/summary";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSummaryType(value: unknown): value is SummaryType {
  return value === "daily" || value === "weekly" || value === "monthly" || value === "yearly";
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
  const taskType = isSummaryType(result.taskType) ? result.taskType : undefined;
  const sinceDate = parseSinceDate(result.since);

  const inferredType: SummaryType | undefined =
    taskType ||
    (result.dailySummaries?.length ? "daily" : undefined) ||
    (result.weeklySummaries?.length ? "weekly" : undefined) ||
    (result.monthlySummaries?.length ? "monthly" : undefined) ||
    (result.result?.content || result.content ? "yearly" : undefined);

  if (!inferredType) return null;

  if (inferredType === "daily") {
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
      title: `Daily Brief (${targetDate})`,
      summary: defaultSummary,
      outputPath: "",
      context: {
        type: "daily",
        id: targetDate,
        repo: defaultRepo,
        repoOptions,
        summariesByRepo,
      },
    };
  }

  if (inferredType === "weekly") {
    if (!sinceDate) return null;
    const weeklySummaries = result.weeklySummaries;
    if (!weeklySummaries?.length) return null;

    const targetWeekStart = toDateString(sinceDate);
    const matched = weeklySummaries.find((w) => w.weekStart === targetWeekStart);
    if (!matched?.summary) return null;

    return {
      year,
      title: `Weekly Report (${targetWeekStart})`,
      summary: matched.summary,
      outputPath: "",
      context: {
        type: "weekly",
        id: matched.weekStart,
      },
    };
  }

  if (inferredType === "monthly") {
    if (!sinceDate) return null;
    const monthlySummaries = result.monthlySummaries;
    if (!monthlySummaries?.length) return null;

    const targetMonth = toMonthString(sinceDate);
    const matched = monthlySummaries.find((m) => m.month === targetMonth);
    if (!matched?.summary) return null;

    return {
      year,
      title: `Monthly Summary (${targetMonth})`,
      summary: matched.summary,
      outputPath: "",
      context: {
        type: "monthly",
        id: matched.month,
      },
    };
  }

  const content = result.result?.content || result.content;
  if (!content) return null;

  return {
    year,
    title: `Yearly Review (${year})`,
    summary: String(content),
    outputPath: "",
    context: {
      type: "yearly",
      id: String(year),
    },
  };
}


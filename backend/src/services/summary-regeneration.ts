import { SUMMARY_TYPES, getIsoWeekEndYmd, getIsoWeekStartYmd, isYmd, type SharedSummaryType } from "@recaply/shared";
import logger from "../lib/logger";
import { SummaryStore } from "../lib/summary-store";
import { badRequest, notFound } from "../lib/errors";

export type RegenerateSummaryRequest = {
  type: SharedSummaryType;
  id: string;
  year: number;
  repo?: string;
  customPrompt?: string;
};

export type RegenerateSummaryResponse =
  | { summary: string }
  | { content: string };

export async function regenerateSummary(
  req: RegenerateSummaryRequest
): Promise<RegenerateSummaryResponse> {
  const store = SummaryStore.getInstance(Number(req.year));
  await store.loadIfExists();

  if (req.type === SUMMARY_TYPES.daily) {
    if (!req.repo) throw badRequest("Missing repo for daily regeneration", { req });

    const rawData = await store.loadRawData(req.id, req.repo);
    if (!rawData) {
      throw notFound("Raw data not found for this date", {
        date: req.id,
        repo: req.repo,
        year: req.year,
      });
    }

    const { processDailySummary } = await import("../workflow/nodes/daily-summarizer.js");
    const newSummary = await processDailySummary({
      ...rawData,
      additionalInstructions: req.customPrompt,
    });

    await store.saveDailySummary(newSummary);
    return { summary: newSummary.summary };
  }

  if (req.type === SUMMARY_TYPES.weekly) {
    const allDailies = await store.loadAllDailySummaries();
    const weekDailies = allDailies.filter((d) => {
      if (!isYmd(d.date)) {
        logger.warn("summary.regenerate: invalid daily date; skipping");
        logger.debug("daily", { date: d.date, repo: d.repo, year: req.year });
        return false;
      }
      return getIsoWeekStartYmd(d.date) === req.id;
    });

    if (weekDailies.length === 0) {
      throw notFound("No daily summaries found for this week", {
        weekStart: req.id,
        year: req.year,
      });
    }

    const weekEnd = getIsoWeekEndYmd(req.id);
    const { processWeeklySummary } = await import("../workflow/nodes/weekly-summarizer.js");
    const newSummary = await processWeeklySummary(
      req.id,
      weekEnd,
      weekDailies,
      req.customPrompt
    );

    await store.saveWeeklySummary(newSummary);
    return { summary: newSummary.summary };
  }

  if (req.type === SUMMARY_TYPES.monthly) {
    const allDailies = await store.loadAllDailySummaries();
    const monthDailies = allDailies.filter((d) => d.date.startsWith(req.id));

    if (monthDailies.length === 0) {
      throw notFound("No daily summaries found for this month", {
        month: req.id,
        year: req.year,
      });
    }

    const { processMonthSummary } = await import("../workflow/nodes/monthly-summarizer.js");
    const newSummary = await processMonthSummary(
      req.id,
      monthDailies,
      req.customPrompt
    );

    await store.saveMonthlySummary(newSummary);
    return { summary: newSummary.summary };
  }

  if (req.type === SUMMARY_TYPES.yearly) {
    const allMonthly = await store.loadAllMonthlySummaries();
    const allWeekly = await store.loadAllWeeklySummaries();

    if (allMonthly.length === 0) {
      throw notFound("No monthly summaries found", { year: req.year });
    }

    const { processYearEndSummary } = await import("../workflow/nodes/year-end-summarizer.js");
    const newSummary = await processYearEndSummary(
      Number(req.year),
      allMonthly,
      allWeekly,
      req.customPrompt
    );

    await store.saveYearEndSummary(newSummary.overview);
    return { content: newSummary.overview };
  }

  throw badRequest("Invalid type parameter", { type: req.type });
}


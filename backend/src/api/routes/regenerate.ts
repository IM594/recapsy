/**
 * Regenerate API - Re-run specific summarization steps with custom prompts
 */

import { Router } from "express";
import fs from "fs/promises";
import path from "path";
import { CheckpointManager } from "../../lib/checkpoint";
import { processDailySummary } from "../../workflow/nodes/daily-summarizer";
import { processMonthSummary } from "../../workflow/nodes/monthly-summarizer";
import { processYearEndSummary } from "../../workflow/nodes/year-end-summarizer";
import logger from "../../lib/logger";

const router = Router();

// Configure output directory (should match what's used in server.ts or provided via config)
// For MVP, we assume a default year or pass it in request
const DEFAULT_YEAR = 2025; // This should be dynamic in production

/**
 * POST /api/year-end/regenerate
 * Regenerate a specific summary with custom instructions
 */
router.post("/year-end/regenerate", async (req, res) => {
  const startTime = Date.now();
  const { type, id, customPrompt, year = DEFAULT_YEAR } = req.body;

  if (!type || !id) {
    return res.status(400).json({ error: "Missing type or id" });
  }

  logger.step("🔄", `Regenerate ${type} - ${id}`, { customPrompt });

  try {
    const checkpointManager = new CheckpointManager(year);
    // Initialize checkpoint if it doesn't exist (readonly mode essentially)
    await checkpointManager.initialize([], "");

    let result;

    if (type === "daily") {
      // 1. Load raw data for this day
      const rawData = await checkpointManager.loadRawData(id);
      if (!rawData) {
        throw new Error(`No raw data found for date ${id}`);
      }

      // 2. Re-run daily summarizer with custom instructions
      result = await processDailySummary({
        ...rawData,
        additionalInstructions: customPrompt,
      });

      // 3. Save updated summary
      await checkpointManager.saveDailySummary(result);
    } else if (type === "monthly") {
      // 1. Load all daily summaries for this month
      // We need to find which days belong to this month
      const allDailies = await checkpointManager.loadAllDailySummaries();
      const monthDailies = allDailies.filter((d) => d.date.startsWith(id));

      if (monthDailies.length === 0) {
        throw new Error(`No daily summaries found for month ${id}`);
      }

      // 2. Re-run monthly summarizer
      result = await processMonthSummary(id, monthDailies, customPrompt);

      // 3. Save updated summary
      await checkpointManager.saveMonthlySummary(result);
    } else if (type === "yearly") {
      // 1. Load all monthly summaries
      const monthlySummaries =
        await checkpointManager.loadAllMonthlySummaries();
      if (monthlySummaries.length === 0) {
        throw new Error("No monthly summaries found");
      }

      // 2. Re-run yearly summarizer
      result = await processYearEndSummary(
        year,
        monthlySummaries,
        customPrompt
      );

      // 3. Save updated summary
      await checkpointManager.saveYearEndSummary(result.overview); // Note: Current saveYearEndSummary only saves string, we might want to save full object too

      // Also save as JSON for consistency if needed, but existing checkpoint manager mostly deals with MD for yearly
      // checkpointManager.saveYearEndSummaryJSON(result); // TODO: Add this method to CheckpointManager
    } else {
      throw new Error(`Invalid type: ${type}`);
    }

    res.json({
      success: true,
      data: result,
      executionTimeMs: Date.now() - startTime,
    });

    logger.stepDone(`Regenerate ${type} complete`, Date.now() - startTime);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(`Regenerate error: ${errMsg}`);
    res.status(500).json({ error: errMsg });
  }
});

/**
 * GET /api/year-end/structure
 * Get the hierarchical structure of existing summaries for the review UI
 */
router.get("/year-end/structure", async (req, res) => {
  const { year = DEFAULT_YEAR } = req.query;
  const targetYear = parseInt(String(year));

  try {
    const checkpointManager = new CheckpointManager(targetYear);
    await checkpointManager.initialize([], ""); // Read-only init

    const checkpoint = checkpointManager.getCheckpoint();
    if (!checkpoint) {
      return res.json({ structure: { year: targetYear, months: [] } });
    }

    // Build the tree structure
    // structure: { year, months: [ { month: "2025-01", days: [ "2025-01-01", ... ] } ] }
    const monthsMap = new Map<string, string[]>();

    // Group completed days by month
    for (const date of checkpoint.dailySummariesCompleted) {
      const month = date.substring(0, 7);
      if (!monthsMap.has(month)) {
        monthsMap.set(month, []);
      }
      monthsMap.get(month)!.push(date);
    }

    // Sort months
    const sortedMonths = Array.from(monthsMap.keys()).sort();

    const structure = {
      year: targetYear,
      hasYearlySummary:
        checkpoint.phase === "complete" ||
        (await fs
          .stat(
            path.join(checkpointManager.getOutputDir(), "year-end-summary.md")
          )
          .then(() => true)
          .catch(() => false)),
      months: sortedMonths.map((month) => ({
        month,
        hasSummary: checkpoint.monthlySummariesCompleted.includes(month),
        days: monthsMap.get(month)!.sort(),
      })),
    };

    res.json({ structure });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: errMsg });
  }
});

/**
 * GET /api/year-end/content
 * Get the markdown content for a specific summary
 */
router.get("/year-end/content", async (req, res) => {
  const { type, id, year = DEFAULT_YEAR } = req.query;
  const targetYear = parseInt(String(year));

  try {
    const checkpointManager = new CheckpointManager(targetYear);
    await checkpointManager.initialize([], "");

    let content = "";

    if (type === "daily") {
      const summary = await checkpointManager.loadDailySummary(String(id));
      content = summary ? summary.summary : "Summary not found";
    } else if (type === "monthly") {
      const summary = await checkpointManager.loadMonthlySummary(String(id));
      content = summary ? summary.summary : "Summary not found";
    } else if (type === "yearly") {
      try {
        content = await fs.readFile(
          path.join(checkpointManager.getOutputDir(), "year-end-summary.md"),
          "utf-8"
        );
      } catch {
        content = "Yearly summary not found";
      }
    }

    res.json({ content });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

export default router;

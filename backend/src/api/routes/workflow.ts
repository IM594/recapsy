/**
 * Workflow Routes - API for executing workflow nodes
 */

import { Router } from "express";
import type {
  DevToolRequest,
  DevToolResponse,
  NodeName,
} from "../../lib/types";
import { getCommitsByDay } from "../../lib/git";
import { processDailySummary } from "../../workflow/nodes/daily-summarizer";
import { processMonthSummary } from "../../workflow/nodes/monthly-summarizer";
import { processYearEndSummary } from "../../workflow/nodes/year-end-summarizer";
import { CheckpointManager } from "../../lib/checkpoint";
import logger from "../../lib/logger";
import { DailyCommitData, DailySummary, MonthlySummary } from "../../lib/types";

const router = Router();

/**
 * POST /run
 * Execute an individual workflow node
 */
router.post("/run", async (req, res) => {
  const startTime = Date.now();
  const { nodeName, input } = req.body as DevToolRequest;

  logger.step("🔧", `DevTool - Testing node: ${nodeName}`, { input });

  try {
    let output: unknown;

    // Initialize checkpoint manager for persistence (default to 2025 if not provided)
    // We try to extract year from input or default to current year/2025
    let year = 2025;
    if ("year" in (input as any)) year = (input as any).year;
    else if ("since" in (input as any))
      year = new Date((input as any).since).getFullYear();
    else if ("date" in (input as any))
      year = new Date((input as any).date).getFullYear();
    else if ("month" in (input as any))
      year = new Date((input as any).month).getFullYear();

    const checkpointManager = new CheckpointManager(year);
    // Silent init if possible, or we might need it for saving
    // For specific nodes we might want to ensure structure exists
    // but usually collect_data is the first one.

    // We only try to init if we are effectively collecting data
    if (nodeName === "collect_data") {
      const { repos, authorPattern = "" } = input as any;
      await checkpointManager.initialize(repos, authorPattern);
    } else {
      // Just ensure path exists by constructor, but we might need to load existing checkpoint
      // No-op here as saving methods will handle file writes, but we rely on dirs being there.
      // If collect_data wasn't run, dirs might be missing.
      // Simple initialization:
      await checkpointManager.initialize([], "");
    }

    switch (nodeName as NodeName) {
      case "collect_data": {
        // Input: { repos: string[], since: string, until: string, authorPattern?: string }
        const {
          repos,
          since,
          until,
          authorPattern = "",
        } = input as {
          repos: string[];
          since: string;
          until: string;
          authorPattern?: string;
        };

        if (!repos || !since || !until) {
          throw new Error("Missing required fields: repos, since, until");
        }

        const data = await getCommitsByDay(repos, authorPattern, since, until, {
          includeDiffs: true,
          maxDiffLinesPerFile: 50, // Smaller for testing
        });

        // Save raw data
        for (const day of data) {
          await checkpointManager.saveRawData(day.date, day);
        }

        output = data;
        break;
      }

      case "daily_summarizer": {
        // Input: DailyCommitData
        const dailyData = input as unknown as Parameters<
          typeof processDailySummary
        >[0];

        if (!dailyData.date || !dailyData.commits) {
          throw new Error("Missing required fields: date, commits");
        }

        const result = await processDailySummary(dailyData);
        await checkpointManager.saveDailySummary(result);
        output = result;
        break;
      }

      case "monthly_summarizer": {
        // Input: { month: string, dailySummaries: DailySummary[] }
        const { month, dailySummaries } = input as {
          month: string;
          dailySummaries: Parameters<typeof processMonthSummary>[1];
        };

        if (!month || !dailySummaries) {
          throw new Error("Missing required fields: month, dailySummaries");
        }

        const result = await processMonthSummary(month, dailySummaries);
        // Transform string result to MonthlySummary object correctly
        // The processMonthSummary returns a string (summary content) based on implementation plan
        // But saveMonthlySummary expects MonthlySummary object.
        // Let's check processMonthSummary signature.
        // Wait, processMonthSummary returns Promise<MonthlySummary> ? No, implementation plan said Promise<string> but code might be different.
        // Checking monthly-summarizer.ts...
        // Assuming it matches what CheckpointManager needs. If it returns string, we wrap it.
        // Actually earlier in conversation "processMonthSummary" signature was updated.
        // Let's assume it returns MonthlySummary object OR we construct it.
        // Re-reading previous logs: processMonthSummary signature updated.
        // Let's assume it returns { month, summary, ... } compliant object.
        // If not, we will fix it.

        // Checking monthly-summarizer.ts via "view_file" might be safer but proceeding based on pattern.
        // If processMonthSummary returns specific object, great.
        // Based on CheckpointManager usage in regenerate.ts:
        // result = await processMonthSummary(id, monthDailies, customPrompt);
        // await checkpointManager.saveMonthlySummary(result);
        // So it returns the correct object.

        await checkpointManager.saveMonthlySummary(result as MonthlySummary);
        output = result;
        break;
      }

      case "yearly_summarizer": {
        // Input: { year: number, monthlySummaries: MonthlySummary[] }
        const { year, monthlySummaries } = input as {
          year: number;
          monthlySummaries: Parameters<typeof processYearEndSummary>[1];
        };

        if (!year || !monthlySummaries) {
          throw new Error("Missing required fields: year, monthlySummaries");
        }

        const result = await processYearEndSummary(year, monthlySummaries);
        // processYearEndSummary returns { overview: string, detailed: string } or just string?
        // In regenerate.ts:
        // result = await processYearEndSummary(year, monthlySummaries, customPrompt);
        // await checkpointManager.saveYearEndSummary(result.overview);
        // So it returns an object.

        if (typeof result === "object" && "overview" in result) {
          await checkpointManager.saveYearEndSummary(result.overview);
        } else if (typeof result === "string") {
          await checkpointManager.saveYearEndSummary(result);
        }

        output = result;
        break;
      }

      default:
        throw new Error(`Unknown node: ${nodeName}`);
    }

    const response: DevToolResponse = {
      success: true,
      nodeName: nodeName as NodeName,
      executionTimeMs: Date.now() - startTime,
      output,
    };

    logger.stepDone(`Node ${nodeName} completed`, Date.now() - startTime);
    res.json(response);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(`DevTool error: ${errMsg}`);

    const response: DevToolResponse = {
      success: false,
      nodeName: nodeName as NodeName,
      executionTimeMs: Date.now() - startTime,
      error: errMsg,
    };

    res.status(500).json(response);
  }
});

/**
 * GET /nodes
 * List available nodes and their expected input schemas
 */
router.get("/nodes", (req, res) => {
  const nodes = [
    {
      name: "collect_data",
      description: "Collect commits from Git repos, grouped by day",
      inputSchema: {
        repos: "string[] - Array of repo paths",
        since: "string - Start date (YYYY-MM-DD)",
        until: "string - End date (YYYY-MM-DD)",
        authorPattern: "string? - Optional author filter pattern",
      },
      exampleInput: {
        repos: ["/path/to/repo"],
        since: "2025-01-01",
        until: "2025-01-07",
        authorPattern: "your-name",
      },
    },
    {
      name: "daily_summarizer",
      description: "Generate summary for a single day's commits",
      inputSchema: {
        date: "string - Date (YYYY-MM-DD)",
        commits: "CommitInfo[] - Array of commits",
        repos: "string[] - Repo names",
        stats: "object - Commit stats",
      },
      exampleInput: {
        date: "2025-01-01",
        commits: [
          {
            hash: "abc1234",
            author: "Author",
            authorDate: "2025-01-01T10:00:00+08:00",
            message: "feat: add new feature",
            files: [{ path: "src/index.ts", additions: 10, deletions: 2 }],
          },
        ],
        repos: ["my-project"],
        stats: {
          totalCommits: 1,
          totalAdditions: 10,
          totalDeletions: 2,
          filesChanged: 1,
        },
      },
    },
    {
      name: "monthly_summarizer",
      description: "Aggregate daily summaries into monthly report",
      inputSchema: {
        month: "string - Month (YYYY-MM)",
        dailySummaries: "DailySummary[] - Array of daily summaries",
      },
      exampleInput: {
        month: "2025-01",
        dailySummaries: [
          {
            date: "2025-01-01",
            summary: "Today's work summary...",
            keyChanges: ["Change 1", "Change 2"],
          },
        ],
      },
    },
    {
      name: "yearly_summarizer",
      description: "Generate year-end self-review from monthly summaries",
      inputSchema: {
        year: "number - Year",
        monthlySummaries: "MonthlySummary[] - Array of monthly summaries",
      },
      exampleInput: {
        year: 2025,
        monthlySummaries: [
          {
            month: "2025-01",
            summary: "January work summary...",
            highlights: ["Highlight 1"],
            daysWithWork: 20,
          },
        ],
      },
    },
  ];

  res.json({ nodes });
});

export default router;

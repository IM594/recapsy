/**
 * DevTool Routes - API for testing individual workflow nodes
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
import logger from "../../lib/logger";

const router = Router();

/**
 * POST /api/devtool/test-node
 * Test an individual workflow node
 */
router.post("/devtool/test-node", async (req, res) => {
  const startTime = Date.now();
  const { nodeName, input } = req.body as DevToolRequest;

  logger.step("🔧", `DevTool - Testing node: ${nodeName}`, { input });

  try {
    let output: unknown;

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

        output = await getCommitsByDay(repos, authorPattern, since, until, {
          includeDiffs: true,
          maxDiffLinesPerFile: 50, // Smaller for testing
        });
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

        output = await processDailySummary(dailyData);
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

        output = await processMonthSummary(month, dailySummaries);
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

        output = await processYearEndSummary(year, monthlySummaries);
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
 * GET /api/devtool/nodes
 * List available nodes and their expected input schemas
 */
router.get("/devtool/nodes", (req, res) => {
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

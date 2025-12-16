import { Router } from "express";
import { createWorkflowGraph } from "../../workflow/graph";
import logger from "../../lib/logger";
import { CheckpointManager } from "../../lib/checkpoint";
import { DailySummary } from "../../lib/types";

const router = Router();
const workflow = createWorkflowGraph();

/**
 * POST /api/summarize
 * Generate work summary (Daily/Weekly/Monthly)
 */
router.post("/summarize", async (req, res) => {
  const startTime = Date.now();

  try {
    const { selectedRepos, since, until, summaryType } = req.body;

    const typeLabels: Record<string, string> = {
      today: "Daily Summary",
      week: "Weekly Summary",
      month: "Monthly Summary",
    };

    logger.taskStart("Workflow Execution", {
      Type: typeLabels[summaryType] || summaryType || "today",
      Repos: selectedRepos?.length || 0,
      Range: `${since || "default"} → ${until || "now"}`,
    });

    const result = await workflow.invoke({
      selectedRepos: selectedRepos || [],
      since: since || "",
      until: until || "",
      summaryType: summaryType || "today",
    });

    // UNIFICATION LOGIC:
    // If we generated a DAILY summary (today), we should save it to the Year-End checkpoint system
    // so it appears in the Year-End Review UI.
    if (summaryType === "today" && result.processedContent?.markdownContent) {
      try {
        const year = new Date().getFullYear(); // Assuming 'today' is in current year
        const checkpointManager = new CheckpointManager(year);
        // Ensure structure exists
        await checkpointManager.initialize([], "");

        // We need to construct a DailySummary object.
        // The workflow output is generic, but we can infer the necessary fields.
        // The 'aiProcessor' node returns { markdownContent, keyChanges, tokenUsage }.
        // We need 'date' which is effectively 'today' (or 'since' if provided).

        const dateKey = since
          ? since.split(" ")[0]
          : new Date().toISOString().split("T")[0];

        // We parse key changes from the AI output or fallback
        // The current aiProcessor might not return structured keyChanges in the same way
        // as daily_summarizer node, but we can try to use what's available or re-parse.
        // For now, we will use the generated markdown as the source of truth.

        const dailySummary: DailySummary = {
          date: dateKey,
          summary: result.processedContent.markdownContent,
          keyChanges: result.processedContent.keyChanges || [],
          tokensUsed: result.processedContent.tokenUsage?.totalTokens || 0,
        };

        await checkpointManager.saveDailySummary(dailySummary);
        logger.info(
          `Saved daily summary for ${dateKey} to Year-End checkpoint`
        );
      } catch (err: any) {
        logger.warn(
          `Failed to save daily summary to checkpoint (non-fatal): ${err.message}`
        );
      }
    }

    const duration = Date.now() - startTime;
    logger.taskEnd("Workflow Execution", duration, result.outputPath);

    res.json({
      status: "completed",
      summary: result.processedContent?.markdownContent || "",
      outputPath: result.outputPath || "",
    });
  } catch (error: any) {
    logger.taskError("Workflow Execution", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;

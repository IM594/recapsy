import { Router, Response } from "express";
import { createSummaryWorkflow } from "../../workflow/graph";
import logger from "../../lib/logger";
import { CheckpointManager } from "../../lib/checkpoint";
import { processDailySummary } from "../../workflow/nodes/daily-summarizer";
import { processWeeklySummary } from "../../workflow/nodes/weekly-summarizer";

const router = Router();

// Use singleton instances to share EventEmitter state for SSE
function getCheckpointManager(year: number): CheckpointManager {
  return CheckpointManager.getInstance(year);
}

/**
 * POST /api/summary/generate
 * Trigger background summarization task
 */
router.post("/generate", async (req, res) => {
  const {
    selectedRepos,
    since,
    until,
    summaryType,
    author,
    year = new Date().getFullYear(),
  } = req.body;

  // Map old summaryType to new taskType
  const taskTypeMap: Record<string, "daily" | "weekly" | "monthly" | "yearly"> =
    {
      today: "daily",
      week: "weekly",
      month: "monthly",
      year_end_Full: "yearly",
    };
  const taskType = taskTypeMap[summaryType] || "daily";

  const checkpoint = getCheckpointManager(year);

  // Check if already running
  if (checkpoint.isRunning()) {
    return res
      .status(409)
      .json({ error: "Task already running", status: checkpoint.getStatus() });
  }

  // Set running state immediately
  await checkpoint.setRunning(true);

  // Start background task
  setImmediate(async () => {
    try {
      logger.taskStart("Workflow Execution", {
        type: taskType,
        range: `${since} -> ${until}`,
      });

      // Initialize the checkpoint manager BEFORE workflow starts
      // This ensures it's in the activeCheckpoints Map so SSE can find it
      await checkpoint.initialize(selectedRepos || [], author || "");
      await checkpoint.updateProgress("init", 0, "Initializing workflow...");

      const workflow = createSummaryWorkflow();
      const result = await workflow.invoke({
        taskType,
        year,
        selectedRepos: selectedRepos || [],
        authorPattern: author || "",
        since: since || "",
        until: until || "",
      });

      // For daily task, we manually save to checkpoint as it might not be fully automated in graph for single-day run
      if (taskType === "daily" && result.dailySummaries?.length > 0) {
        // Graph nodes already save to checkpoint, so we might duplicate strict save logic here
        // but verify if 'persist' node is reached.
        // Since graph has "persist" node, it should be auto-saved.
        // We just log success.
      }

      await checkpoint.markComplete(result);
      logger.taskEnd("Workflow Execution", 0, "completed");
    } catch (error: any) {
      logger.error(`Workflow failed: ${error.message}`);
      await checkpoint.markError(error.message);
    }
  });

  res.json({ status: "started", message: "Task started in background" });
});

/**
 * GET /api/summary/events
 * Server-Sent Events for progress updates
 */
router.get("/events", async (req, res) => {
  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  const checkpoint = getCheckpointManager(year);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (event: string, data: any) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Send initial status
  const currentStatus = checkpoint.getStatus();
  sendEvent("status", currentStatus);

  // Event handlers
  const onProgress = (data: any) => sendEvent("progress", data);
  const onComplete = (data: any) => sendEvent("complete", data);
  const onError = (err: any) => sendEvent("error", { message: err });

  checkpoint.on("progress", onProgress);
  checkpoint.on("complete", onComplete);
  checkpoint.on("error", onError);

  req.on("close", () => {
    checkpoint.off("progress", onProgress);
    checkpoint.off("complete", onComplete);
    checkpoint.off("error", onError);
  });
});

/**
 * GET /api/summary/status
 * Get current task status
 */
router.get("/status", async (req, res) => {
  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  const checkpoint = getCheckpointManager(year);
  // Ensure we have latest from disk if this is a fresh instance (fallback)
  if (!checkpoint.getCheckpoint()) {
    await checkpoint.initialize([], "");
  }
  res.json(checkpoint.getStatus());
});

/**
 * GET /api/summary/data
 * Get generated data (daily/monthly/yearly)
 */
router.get("/data", async (req, res) => {
  const { type, year = new Date().getFullYear(), repo } = req.query;
  const checkpoint = getCheckpointManager(Number(year));
  await checkpoint.initialize([], ""); // Ensure loaded

  try {
    if (type === "daily") {
      // Return all daily summaries, optionally filtered by repo
      const allDailies = await checkpoint.loadAllDailySummaries();
      const filtered = repo
        ? allDailies.filter((d) => d.repo === repo)
        : allDailies;
      return res.json(filtered);
    }

    if (type === "monthly") {
      const monthlies = await checkpoint.loadAllMonthlySummaries();
      return res.json(monthlies);
    }

    if (type === "yearly") {
      const content = await checkpoint.loadYearEndSummary();
      return res.json({ content });
    }

    res.status(400).json({ error: "Invalid type" });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/summary/regenerate
 * Regenerate specific item
 */
router.post("/regenerate", async (req, res) => {
  const {
    type,
    id,
    repo,
    customPrompt,
    year = new Date().getFullYear(),
  } = req.body;
  const checkpoint = getCheckpointManager(year);
  await checkpoint.initialize([], "");

  try {
    if (type === "daily") {
      if (!repo) return res.status(400).json({ error: "Missing repo" });
      const rawData = await checkpoint.loadRawData(id, repo);
      if (!rawData) throw new Error("Raw data not found");

      const result = await processDailySummary({
        ...rawData,
        additionalInstructions: customPrompt,
      });
      await checkpoint.saveDailySummary(result);
      return res.json(result);
    }
    if (type === "weekly") {
      const existing = await checkpoint.loadWeeklySummary(id); // id is weekStart
      if (!existing) throw new Error("Weekly summary not found");

      const weekStartStr = new Date(existing.weekStart).toLocaleDateString(
        "en-CA"
      ); // YYYY-MM-DD
      const weekEndStr = new Date(existing.weekEnd).toLocaleDateString("en-CA"); // YYYY-MM-DD

      console.log(
        `[Regenerate] Weekly Range (UTC parsed to Local YMD): ${weekStartStr} -> ${weekEndStr}`
      );
      console.log(
        `[Regenerate] Original ISO: ${existing.weekStart} -> ${existing.weekEnd}`
      );

      // Load all dailies and filter by range
      const allDailies = await checkpoint.loadAllDailySummaries();
      console.log(
        `[Regenerate] Found ${allDailies.length} total daily summaries`
      );

      const relevantDailies = allDailies.filter(
        (d) => d.date >= weekStartStr && d.date <= weekEndStr
      );
      console.log(
        `[Regenerate] Filtered ${relevantDailies.length} relevant dailies`
      );

      if (relevantDailies.length === 0) {
        const availableDates = allDailies.map((d) => d.date).join(", ");
        throw new Error(
          `No data found for range ${weekStartStr} to ${weekEndStr}. Available dates: [${availableDates}]`
        );
      }

      const result = await processWeeklySummary(
        existing.weekStart,
        existing.weekEnd,
        relevantDailies,
        customPrompt
      );
      await checkpoint.saveWeeklySummary(result);
      return res.json(result);
    }

    // Implement monthly/yearly similarly if needed
    res.status(501).json({ error: "Not implemented for this type yet" });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/summary/reset
 * Reset checkpoint status to idle (for regeneration)
 */
router.post("/reset", async (req, res) => {
  const { year = new Date().getFullYear() } = req.body;
  const checkpoint = getCheckpointManager(year);

  try {
    await checkpoint.initialize([], "");
    await checkpoint.resetStatus();
    res.json({ success: true, status: checkpoint.getStatus() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

import { Router, Response } from "express";
import { createSummaryWorkflow } from "../../workflow/graph";
import logger from "../../lib/logger";
import { CheckpointManager } from "../../lib/checkpoint";
import {
  getCheckpointer,
  generateThreadId,
  createThreadConfig,
} from "../../lib/saver";
import { processDailySummary } from "../../workflow/nodes/daily-summarizer";
import { processWeeklySummary } from "../../workflow/nodes/weekly-summarizer";
import { processMonthSummary } from "../../workflow/nodes/monthly-summarizer";
import { processYearEndSummary } from "../../workflow/nodes/year-end-summarizer";

const router = Router();

// Use singleton instances to share EventEmitter state for SSE
function getCheckpointManager(year: number): CheckpointManager {
  return CheckpointManager.getInstance(year);
}

/**
 * POST /api/summary/generate
 * Trigger background summarization task with streaming progress
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

  // Validate taskType
  const validTaskTypes = ["daily", "weekly", "monthly", "yearly"] as const;
  type TaskType = (typeof validTaskTypes)[number];
  const taskType: TaskType = validTaskTypes.includes(summaryType)
    ? summaryType
    : "daily";

  const checkpoint = getCheckpointManager(year);

  // CRITICAL: Initialize checkpoint FIRST to ensure state persistence works
  await checkpoint.initialize(selectedRepos || [], author || "");

  // Check if already running (now we can reliably read from disk)
  if (checkpoint.isRunning()) {
    return res
      .status(409)
      .json({ error: "Task already running", status: checkpoint.getStatus() });
  }

  // Atomically set running state with phase
  await checkpoint.setRunningWithPhase(true, "starting");

  // Generate thread ID for this workflow execution (enables resume capability)
  const threadId = generateThreadId(taskType, year, selectedRepos || []);
  const threadConfig = createThreadConfig(threadId);

  // Start background task with streaming
  setImmediate(async () => {
    try {
      logger.taskStart("Workflow Execution", {
        type: taskType,
        range: `${since} -> ${until}`,
        threadId,
      });

      // Get native checkpointer and create workflow with it
      const checkpointer = await getCheckpointer();
      const workflow = await createSummaryWorkflow(checkpointer);

      const input = {
        taskType,
        year,
        selectedRepos: selectedRepos || [],
        authorPattern: author || "",
        since: since || "",
        until: until || "",
      };

      // Use stream() instead of invoke() for progress updates
      // streamMode: "updates" gives us state changes after each node
      const stream = await workflow.stream(input, {
        ...threadConfig,
        streamMode: "updates",
      });

      let lastState: any = null;
      for await (const chunk of stream) {
        // chunk is { [nodeName]: stateUpdate }
        const chunkData = chunk as Record<string, any>;
        const nodeNames = Object.keys(chunkData);
        for (const nodeName of nodeNames) {
          const stateUpdate = chunkData[nodeName];
          lastState = { ...lastState, ...stateUpdate };

          // Emit progress event via checkpoint EventEmitter
          if (stateUpdate?.progress !== undefined) {
            checkpoint.emit("progress", {
              step: stateUpdate.currentStep || nodeName,
              progress: stateUpdate.progress,
              message: `Completed: ${nodeName}`,
            });
          }
        }
      }

      await checkpoint.markComplete(lastState);
      logger.taskEnd("Workflow Execution", 0, "completed");
    } catch (error: any) {
      logger.error(`Workflow failed: ${error.message}`);
      await checkpoint.markError(error.message);
    }
  });

  res.json({
    status: "started",
    message: "Task started in background with streaming",
    threadId,
  });
});

/**
 * GET /api/summary/events
 * Server-Sent Events for progress updates
 *
 * New event format: { nodeId, state: { progress, currentStep }, timestamp }
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

  // Send initial status with new format
  const currentStatus = checkpoint.getStatus();
  sendEvent("status", {
    nodeId: currentStatus.currentStep || "idle",
    state: {
      progress: currentStatus.progress,
      currentStep: currentStatus.currentStep,
      phase: currentStatus.phase,
      isRunning: currentStatus.isRunning,
    },
    timestamp: Date.now(),
  });

  // Event handlers with new format
  const onProgress = (data: any) => {
    sendEvent("progress", {
      nodeId: data.step,
      state: {
        progress: data.progress,
        currentStep: data.step,
        message: data.message,
      },
      timestamp: Date.now(),
    });
  };

  const onComplete = (data: any) => {
    sendEvent("complete", {
      nodeId: "persist",
      state: {
        progress: 100,
        currentStep: "complete",
        result: data?.result,
      },
      timestamp: Date.now(),
    });
  };

  const onError = (err: any) => {
    sendEvent("workflow_error", {
      nodeId: "error",
      state: {
        error: typeof err === "string" ? err : err?.message || "Unknown error",
      },
      timestamp: Date.now(),
    });
  };

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
 * Get current task status (read-only, no side effects)
 */
router.get("/status", async (req, res) => {
  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  const checkpoint = getCheckpointManager(year);
  // Load existing checkpoint from disk without creating new one
  await checkpoint.loadIfExists();
  res.json(checkpoint.getStatus());
});

/**
 * GET /api/summary/data
 * Get generated data (daily/monthly/yearly) - read-only
 */
router.get("/data", async (req, res) => {
  const { type, year = new Date().getFullYear(), repo } = req.query;
  const checkpoint = getCheckpointManager(Number(year));
  await checkpoint.loadIfExists(); // Read-only load, no state mutation

  try {
    if (type === "daily") {
      // Return all daily summaries, optionally filtered by repo
      const allDailies = await checkpoint.loadAllDailySummaries();
      const filtered = repo
        ? allDailies.filter((d) => d.repo === repo)
        : allDailies;
      return res.json(filtered);
    }

    if (type === "weekly") {
      const weeklies = await checkpoint.loadAllWeeklySummaries();
      return res.json(weeklies);
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
  await checkpoint.loadIfExists();

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

      logger.info(
        `[Regenerate] Weekly Range: ${weekStartStr} -> ${weekEndStr}`
      );

      // Load all dailies and filter by range
      const allDailies = await checkpoint.loadAllDailySummaries();
      const relevantDailies = allDailies.filter(
        (d) => d.date >= weekStartStr && d.date <= weekEndStr
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

    if (type === "monthly") {
      // id is month in YYYY-MM format
      const allDailies = await checkpoint.loadAllDailySummaries();
      const relevantDailies = allDailies.filter((d) => d.date.startsWith(id));

      if (relevantDailies.length === 0) {
        throw new Error(`No daily summaries found for month ${id}`);
      }

      const result = await processMonthSummary(
        id,
        relevantDailies,
        customPrompt
      );
      await checkpoint.saveMonthlySummary(result);
      return res.json(result);
    }

    if (type === "yearly") {
      // id is year as string
      const monthlySummaries = await checkpoint.loadAllMonthlySummaries();

      if (monthlySummaries.length === 0) {
        throw new Error(`No monthly summaries found for year ${year}`);
      }

      const result = await processYearEndSummary(
        year,
        monthlySummaries,
        customPrompt
      );
      await checkpoint.saveYearEndSummary(result.overview);
      return res.json({ summary: result.overview, ...result });
    }

    res.status(400).json({ error: `Invalid type: ${type}` });
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
    await checkpoint.loadIfExists();
    await checkpoint.resetStatus();
    res.json({ success: true, status: checkpoint.getStatus() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

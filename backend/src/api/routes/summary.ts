/**
 * Summary API Routes
 *
 * Uses:
 * - SummaryStore: Data persistence (generated summaries)
 * - WorkflowRunner: Runtime state + SSE events (ephemeral)
 * - LangGraph workflow.stream(): Real-time progress from workflow execution
 */

import { Router } from "express";
import { createSummaryWorkflow } from "../../workflow/graph";
import logger from "../../lib/logger";
import { SummaryStore } from "../../lib/summary-store";
import { WorkflowRunner } from "../../lib/workflow-runner";
import fs from "fs/promises";
import path from "path";
import { getBaseOutputDir } from "../../lib/paths";

const router = Router();

/**
 * GET /api/summary/years
 * Return years that have existing persisted data + current year.
 *
 * This powers the year switcher in the UI.
 */
router.get("/years", async (_req, res) => {
  const currentYear = new Date().getFullYear();
  const years = new Set<number>([currentYear]);

  try {
    const baseDir = getBaseOutputDir();
    const entries = await fs.readdir(baseDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith("year-end-")) continue;
      const yearStr = entry.name.replace("year-end-", "");
      const yearNum = Number.parseInt(yearStr, 10);
      if (Number.isFinite(yearNum)) years.add(yearNum);
    }
  } catch {
    // Ignore missing directories / read errors and still return currentYear.
  }

  res.json({
    years: Array.from(years).sort((a, b) => b - a), // newest first
  });
});

/**
 * POST /api/summary/generate
 * Start workflow execution with streaming progress
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

  const validTaskTypes = ["daily", "weekly", "monthly", "yearly"] as const;
  type TaskType = (typeof validTaskTypes)[number];
  const taskType: TaskType = validTaskTypes.includes(summaryType)
    ? summaryType
    : "daily";

  const runner = WorkflowRunner.getInstance(year);
  const store = SummaryStore.getInstance(year);

  // Check if already running
  if (runner.isRunning()) {
    return res.status(409).json({
      error: "Task already running",
      status: runner.getStatus(),
    });
  }

  // Initialize store and mark as running
  await store.initialize(selectedRepos || [], author || "");
  runner.start();

  // Execute workflow in background
  setImmediate(async () => {
    try {
      logger.taskStart("Workflow Execution", {
        type: taskType,
        range: `${since} -> ${until}`,
      });

      const workflow = await createSummaryWorkflow();

      const input = {
        taskType,
        year,
        selectedRepos: selectedRepos || [],
        authorPattern: author || "",
        since: since || "",
        until: until || "",
      };

      // Stream workflow execution for real-time progress
      const stream = await workflow.stream(input, {
        streamMode: "updates",
      });

      let lastState: any = null;
      for await (const chunk of stream) {
        const chunkData = chunk as Record<string, any>;
        for (const nodeName of Object.keys(chunkData)) {
          const stateUpdate = chunkData[nodeName];
          lastState = { ...lastState, ...stateUpdate };

          // Emit progress via WorkflowRunner
          if (stateUpdate?.progress !== undefined) {
            runner.updateProgress(
              stateUpdate.currentStep || nodeName,
              stateUpdate.progress,
              `Completed: ${nodeName}`
            );
          }
        }
      }

      runner.complete(lastState);
      logger.taskEnd("Workflow Execution", 0, "completed");
    } catch (error: any) {
      logger.error(`Workflow failed: ${error.message}`);
      runner.error(error.message);
    }
  });

  res.json({
    status: "started",
    message: "Workflow started in background",
  });
});

/**
 * GET /api/summary/events
 * Server-Sent Events for real-time progress
 */
router.get("/events", async (req, res) => {
  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  const runner = WorkflowRunner.getInstance(year);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (event: string, data: any) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Send initial status
  const status = runner.getStatus();
  sendEvent("status", {
    nodeId: status.currentStep || "idle",
    state: {
      progress: status.progress,
      currentStep: status.currentStep,
      phase: status.phase,
      isRunning: status.isRunning,
    },
    timestamp: Date.now(),
  });

  // Event handlers
  const onProgress = (data: any) => sendEvent("progress", data);
  const onComplete = (data: any) => sendEvent("complete", data);
  const onError = (data: any) => sendEvent("workflow_error", data);

  runner.on("progress", onProgress);
  runner.on("complete", onComplete);
  runner.on("workflow_error", onError);

  req.on("close", () => {
    runner.off("progress", onProgress);
    runner.off("complete", onComplete);
    runner.off("workflow_error", onError);
  });
});

/**
 * GET /api/summary/status
 * Get current workflow status
 */
router.get("/status", async (req, res) => {
  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  const runner = WorkflowRunner.getInstance(year);
  res.json(runner.getStatus());
});

/**
 * POST /api/summary/reset
 * Reset workflow status to idle
 */
router.post("/reset", async (req, res) => {
  const { year = new Date().getFullYear() } = req.body;
  const runner = WorkflowRunner.getInstance(year);
  runner.reset();
  res.json({ success: true, status: runner.getStatus() });
});

/**
 * GET /api/summary/data
 * Get generated summary data
 */
router.get("/data", async (req, res) => {
  const { type, year = new Date().getFullYear(), repo } = req.query;
  const store = SummaryStore.getInstance(Number(year));
  await store.loadIfExists();

  try {
    if (type === "daily") {
      const all = await store.loadAllDailySummaries();
      const filtered = repo ? all.filter((d) => d.repo === repo) : all;
      return res.json(filtered);
    }

    if (type === "weekly") {
      return res.json(await store.loadAllWeeklySummaries());
    }

    if (type === "monthly") {
      return res.json(await store.loadAllMonthlySummaries());
    }

    if (type === "yearly") {
      const summary = await store.loadYearEndSummary();
      return res.json(summary ? { content: summary } : null);
    }

    res.status(400).json({ error: "Invalid type parameter" });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/summary/regenerate
 * Regenerate a specific summary with optional custom prompt
 */
router.post("/regenerate", async (req, res) => {
  const {
    type,
    id,
    year = new Date().getFullYear(),
    customPrompt,
    repo,
  } = req.body;

  if (!type || !id) {
    return res.status(400).json({ error: "Missing type or id" });
  }

  const store = SummaryStore.getInstance(Number(year));
  await store.loadIfExists();

  try {
    if (type === "daily") {
      // Load raw data for the day
      if (!repo) {
        return res
          .status(400)
          .json({ error: "Missing repo for daily regeneration" });
      }

      const rawData = await store.loadRawData(id, repo);
      if (!rawData) {
        return res
          .status(404)
          .json({ error: "Raw data not found for this date" });
      }

      // Import and call processDailySummary
      const { processDailySummary } = await import(
        "../../workflow/nodes/daily-summarizer.js"
      );
      const newSummary = await processDailySummary({
        ...rawData,
        additionalInstructions: customPrompt,
      });

      // Save and return
      await store.saveDailySummary(newSummary);
      return res.json({ summary: newSummary.summary });
    }

    if (type === "weekly") {
      // id is weekStart
      const allDailies = await store.loadAllDailySummaries();
      const weekDailies = allDailies.filter((d) => {
        const weekStart = getWeekStart(d.date);
        return weekStart === id;
      });

      if (weekDailies.length === 0) {
        return res
          .status(404)
          .json({ error: "No daily summaries found for this week" });
      }

      const weekEnd = getWeekEnd(id);
      const { processWeeklySummary } = await import(
        "../../workflow/nodes/weekly-summarizer.js"
      );
      const newSummary = await processWeeklySummary(
        id,
        weekEnd,
        weekDailies,
        customPrompt
      );

      await store.saveWeeklySummary(newSummary);
      return res.json({ summary: newSummary.summary });
    }

    if (type === "monthly") {
      // id is month (YYYY-MM)
      const allDailies = await store.loadAllDailySummaries();
      const monthDailies = allDailies.filter((d) => d.date.startsWith(id));

      if (monthDailies.length === 0) {
        return res
          .status(404)
          .json({ error: "No daily summaries found for this month" });
      }

      const { processMonthSummary } = await import(
        "../../workflow/nodes/monthly-summarizer.js"
      );
      const newSummary = await processMonthSummary(
        id,
        monthDailies,
        customPrompt
      );

      await store.saveMonthlySummary(newSummary);
      return res.json({ summary: newSummary.summary });
    }

    if (type === "yearly") {
      const allMonthly = await store.loadAllMonthlySummaries();
      const allWeekly = await store.loadAllWeeklySummaries();

      if (allMonthly.length === 0) {
        return res.status(404).json({ error: "No monthly summaries found" });
      }

      const { processYearEndSummary } = await import(
        "../../workflow/nodes/year-end-summarizer.js"
      );
      // New signature: (year, monthly, weekly, customPrompt)
      const newSummary = await processYearEndSummary(
        Number(year),
        allMonthly,
        allWeekly,
        customPrompt
      );

      await store.saveYearEndSummary(newSummary.overview);
      return res.json({ content: newSummary.overview });
    }

    res.status(400).json({ error: "Invalid type parameter" });
  } catch (error: any) {
    logger.error(`Regeneration failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Helper functions for week calculation
function getWeekStart(dateStr: string): string {
  const d = new Date(dateStr);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  return monday.toISOString().slice(0, 10);
}

function getWeekEnd(weekStart: string): string {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + 6);
  return d.toISOString().slice(0, 10);
}

export default router;

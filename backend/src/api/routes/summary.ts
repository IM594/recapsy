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
import {
  getCheckpointer,
  generateThreadId,
  createThreadConfig,
} from "../../lib/saver";

const router = Router();

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

  // Generate thread ID for LangGraph checkpointing
  const threadId = generateThreadId(taskType, year, selectedRepos || []);
  const threadConfig = createThreadConfig(threadId);

  // Execute workflow in background
  setImmediate(async () => {
    try {
      logger.taskStart("Workflow Execution", {
        type: taskType,
        range: `${since} -> ${until}`,
        threadId,
      });

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

      // Stream workflow execution for real-time progress
      const stream = await workflow.stream(input, {
        ...threadConfig,
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
    threadId,
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

export default router;

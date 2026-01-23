/**
 * Summary API Routes
 *
 * Uses:
 * - SummaryStore: Data persistence (generated summaries)
 * - WorkflowRunner: Runtime state + SSE events (ephemeral)
 * - LangGraph workflow.stream(): Real-time progress from workflow execution
 */

import { Router } from "express";
import { WorkflowRunner } from "../../lib/workflow-runner";
import {
  QUERY_KEYS,
  SSE_EVENTS,
  SUMMARY_ROUTES,
} from "@recaply/shared";
import { asyncHandler } from "../middleware/async-handler";
import {
  parseGenerateSummaryBody,
  parseRegenerateSummaryBody,
  parseSummaryDataQuery,
  parseYear,
} from "../validators/summary";
import {
  fetchSummaryData,
  listAvailableYears,
  resetWorkflowStatus,
  startSummaryGeneration,
} from "../../services/summary-service";
import { regenerateSummary } from "../../services/summary-regeneration";

const router = Router();

/**
 * GET /api/summary/years
 * Return years that have existing persisted data + current year.
 *
 * This powers the year switcher in the UI.
 */
router.get(
  SUMMARY_ROUTES.years,
  asyncHandler(async (_req, res) => {
    res.json({
      years: await listAvailableYears(),
    });
  })
);

/**
 * POST /api/summary/generate
 * Start workflow execution with streaming progress
 */
router.post(
  SUMMARY_ROUTES.generate,
  asyncHandler(async (req, res) => {
    const { selectedRepos, since, until, summaryType, author, year } =
      parseGenerateSummaryBody(req.body);

    const result = await startSummaryGeneration({
      selectedRepos,
      since,
      until,
      summaryType,
      author,
      year,
    });

    if (result.kind === "already_running") {
      const requestId = res.locals.requestId as string | undefined;
      return res.status(409).json({
        error: "Task already running",
        code: result.code,
        requestId,
        status: result.status,
      });
    }

    res.json({
      status: "started",
      message: "Workflow started in background",
    });
  })
);

/**
 * GET /api/summary/events
 * Server-Sent Events for real-time progress
 */
router.get(
  SUMMARY_ROUTES.events,
  asyncHandler(async (req, res) => {
    const year = parseYear(req.query[QUERY_KEYS.year], new Date().getFullYear());
    const runner = WorkflowRunner.getInstance(year);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const sendEvent = (event: string, data: any) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Send initial status
    const status = runner.getStatus();
    sendEvent(SSE_EVENTS.status, {
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
    const onProgress = (data: any) => sendEvent(SSE_EVENTS.progress, data);
    const onComplete = (data: any) => sendEvent(SSE_EVENTS.complete, data);
    const onError = (data: any) => sendEvent(SSE_EVENTS.workflowError, data);

    runner.on(SSE_EVENTS.progress, onProgress);
    runner.on(SSE_EVENTS.complete, onComplete);
    runner.on(SSE_EVENTS.workflowError, onError);

    req.on("close", () => {
      runner.off(SSE_EVENTS.progress, onProgress);
      runner.off(SSE_EVENTS.complete, onComplete);
      runner.off(SSE_EVENTS.workflowError, onError);
    });
  })
);

/**
 * GET /api/summary/status
 * Get current workflow status
 */
router.get(
  SUMMARY_ROUTES.status,
  asyncHandler(async (req, res) => {
    const year = parseYear(req.query[QUERY_KEYS.year], new Date().getFullYear());
    const runner = WorkflowRunner.getInstance(year);
    res.json(runner.getStatus());
  })
);

/**
 * POST /api/summary/reset
 * Reset workflow status to idle
 */
router.post(
  SUMMARY_ROUTES.reset,
  asyncHandler(async (req, res) => {
    const year = parseYear((req.body as { year?: unknown } | null | undefined)?.year, new Date().getFullYear());
    const status = resetWorkflowStatus(year);
    res.json({ success: true, status });
  })
);

/**
 * GET /api/summary/data
 * Get generated summary data
 */
router.get(
  SUMMARY_ROUTES.data,
  asyncHandler(async (req, res) => {
    const { type, repo, year } = parseSummaryDataQuery(req.query, {
      type: QUERY_KEYS.type,
      repo: QUERY_KEYS.repo,
      year: QUERY_KEYS.year,
    });
    const data = await fetchSummaryData({ year, type, repo });
    return res.json(data);
  })
);

/**
 * POST /api/summary/regenerate
 * Regenerate a specific summary with optional custom prompt
 */
router.post(
  SUMMARY_ROUTES.regenerate,
  asyncHandler(async (req, res) => {
    const { type, id, year, customPrompt, repo } = parseRegenerateSummaryBody(req.body);
    const result = await regenerateSummary({
      type,
      id,
      year,
      repo,
      customPrompt,
    });
    return res.json(result);
  })
);

export default router;

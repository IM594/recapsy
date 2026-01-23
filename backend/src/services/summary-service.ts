import fs from "fs/promises";
import { createSummaryWorkflow } from "../workflow/graph";
import logger from "../lib/logger";
import { getBaseOutputDir } from "../lib/paths";
import { SummaryStore } from "../lib/summary-store";
import { WorkflowRunner, type RuntimeStatus } from "../lib/workflow-runner";
import {
  ERROR_CODES,
  SUMMARY_TYPES,
  type SharedSummaryType,
} from "@recaply/shared";

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

export async function listAvailableYears(): Promise<number[]> {
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
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      logger.debug("summary.years: outputDir missing", getBaseOutputDir());
    } else {
      logger.warn("summary.years: failed to scan outputDir; returning current year only");
      logger.error("summary.years: scan error", error instanceof Error ? error : undefined);
      logger.debug("outputDir", getBaseOutputDir());
    }
  }

  return Array.from(years).sort((a, b) => b - a);
}

export type SummaryDataResponse =
  | Awaited<ReturnType<SummaryStore["loadAllDailySummaries"]>>
  | Awaited<ReturnType<SummaryStore["loadAllWeeklySummaries"]>>
  | Awaited<ReturnType<SummaryStore["loadAllMonthlySummaries"]>>
  | { content: string }
  | null;

export async function fetchSummaryData(opts: {
  year: number;
  type: SharedSummaryType;
  repo?: string;
}): Promise<SummaryDataResponse> {
  const store = SummaryStore.getInstance(opts.year);
  await store.loadIfExists();

  try {
    if (opts.type === SUMMARY_TYPES.daily) {
      const all = await store.loadAllDailySummaries();
      return opts.repo ? all.filter((d) => d.repo === opts.repo) : all;
    }

    if (opts.type === SUMMARY_TYPES.weekly) {
      return await store.loadAllWeeklySummaries();
    }

    if (opts.type === SUMMARY_TYPES.monthly) {
      return await store.loadAllMonthlySummaries();
    }

    if (opts.type === SUMMARY_TYPES.yearly) {
      const summary = await store.loadYearEndSummary();
      return summary ? { content: summary } : null;
    }

    // Should not happen if callers validate summary type.
    throw new Error(`Invalid summary type: ${opts.type}`);
  } catch (error) {
    logger.error("summary.data: failed to load data", error instanceof Error ? error : undefined);
    logger.debug("query", opts);
    throw error;
  }
}

export type StartSummaryGenerationRequest = {
  selectedRepos: string[];
  since: string;
  until: string;
  summaryType: SharedSummaryType;
  author: string;
  year: number;
};

export type StartSummaryGenerationResult =
  | { kind: "started" }
  | { kind: "already_running"; status: RuntimeStatus; code: typeof ERROR_CODES.conflict };

export async function startSummaryGeneration(
  req: StartSummaryGenerationRequest
): Promise<StartSummaryGenerationResult> {
  const taskType = req.summaryType;
  const runner = WorkflowRunner.getInstance(req.year);
  const store = SummaryStore.getInstance(req.year);

  if (runner.isRunning()) {
    return { kind: "already_running", status: runner.getStatus(), code: ERROR_CODES.conflict };
  }

  await store.initialize(req.selectedRepos, req.author || "");
  runner.start();

  setImmediate(async () => {
    const startedAt = Date.now();
    try {
      logger.taskStart("Workflow Execution", {
        type: taskType,
        year: req.year,
        range: `${req.since} -> ${req.until}`,
      });

      const workflow = await createSummaryWorkflow();
      const input = {
        taskType,
        year: req.year,
        selectedRepos: req.selectedRepos,
        authorPattern: req.author || "",
        since: req.since,
        until: req.until,
      };

      const stream = await workflow.stream(input, { streamMode: "updates" });

      let lastState: unknown = null;
      for await (const chunk of stream) {
        const chunkData = chunk as Record<string, any>;
        for (const nodeName of Object.keys(chunkData)) {
          const stateUpdate = chunkData[nodeName];
          lastState = { ...(lastState as any), ...(stateUpdate as any) };

          if (typeof stateUpdate?.progress === "number" && Number.isFinite(stateUpdate.progress)) {
            runner.updateProgress(
              stateUpdate.currentStep || nodeName,
              stateUpdate.progress,
              `Completed: ${nodeName}`
            );
          }
        }
      }

      runner.complete(lastState);
      logger.taskEnd("Workflow Execution", Date.now() - startedAt, "completed");
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("Workflow failed", err);
      logger.debug("workflow", { year: req.year, taskType });
      runner.error(err.message);
      logger.taskError("Workflow Execution", err);
    }
  });

  return { kind: "started" };
}

export function resetWorkflowStatus(year: number): RuntimeStatus {
  const runner = WorkflowRunner.getInstance(year);
  runner.reset();
  return runner.getStatus();
}


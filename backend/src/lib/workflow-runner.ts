/**
 * WorkflowRunner - Ephemeral runtime state and SSE event emitter
 *
 * This class manages:
 * - Runtime state (isRunning, progress, currentStep) - NOT persisted
 * - SSE event emission (progress, complete, error)
 * - Workflow execution coordination
 *
 * Runtime state is intentionally ephemeral - if the server restarts,
 * the running state is lost but that's correct behavior since the
 * workflow process would have died anyway.
 */

import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { getWorkflowDebugLogPath } from "./paths";
import { SSE_EVENTS, WORKFLOW_PHASES, WORKFLOW_STEP_IDS, type WorkflowPhase } from "@recaply/shared";
import logger from "./logger";

export interface RuntimeStatus {
  isRunning: boolean;
  progress: number;
  currentStep: string | null;
  phase: WorkflowPhase;
  error?: string;
}

export interface ProgressEvent {
  nodeId: string;
  state: {
    progress: number;
    currentStep: string;
    message?: string;
  };
  timestamp: number;
}

// Singleton instances by year
const runnersByYear = new Map<number, WorkflowRunner>();

export class WorkflowRunner extends EventEmitter {
  private year: number;
  private logFilePath: string;
  private fileLoggingEnabled = true;
  private status: RuntimeStatus = {
    isRunning: false,
    progress: 0,
    currentStep: null,
    phase: WORKFLOW_PHASES.idle,
  };

  static getInstance(year: number): WorkflowRunner {
    if (!runnersByYear.has(year)) {
      runnersByYear.set(year, new WorkflowRunner(year));
    }
    return runnersByYear.get(year)!;
  }

  constructor(year: number) {
    super();
    this.year = year;
    this.logFilePath = getWorkflowDebugLogPath();
    try {
      fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true });
    } catch (e) {
      this.fileLoggingEnabled = false;
      logger.error(
        "WorkflowRunner: failed to create output directory for logs",
        e instanceof Error ? e : undefined
      );
      logger.debug("logFilePath", this.logFilePath);
    }
    this.logToFile(
      `\n=== New WorkflowRunner Instance (Year: ${year}) - ${new Date().toISOString()} ===\n`
    );
  }

  private logToFile(message: string) {
    if (!this.fileLoggingEnabled) return;
    try {
      fs.appendFileSync(this.logFilePath, message + "\n");
    } catch (err) {
      this.fileLoggingEnabled = false;
      logger.error(
        "WorkflowRunner: failed to write to workflow debug log; disabling file logging",
        err instanceof Error ? err : undefined
      );
      logger.debug("logFilePath", this.logFilePath);
    }
  }

  // ============ Runtime State ============

  isRunning(): boolean {
    return this.status.isRunning;
  }

  getStatus(): RuntimeStatus {
    return { ...this.status };
  }

  start(): void {
    // Clear all progress counters from previous runs
    this.progressCounters.clear();
    this.status = {
      isRunning: true,
      progress: 0,
      currentStep: WORKFLOW_STEP_IDS.starting,
      phase: WORKFLOW_PHASES.running,
    };
  }

  // Atomic counters for parallel progress tracking
  private progressCounters = new Map<
    string,
    { current: number; total: number }
  >();

  /**
   * Reset a specific progress counter (for new phase)
   */
  resetProgressCounter(nodeId: string): void {
    this.progressCounters.delete(nodeId);
  }

  // ============ Progress Updates ============

  /**
   * Atomically increment progress for a step (handles parallel execution)
   */
  incrementProgress(nodeId: string, total: number, message?: string): void {
    const info = this.progressCounters.get(nodeId) || { current: 0, total };
    info.current += 1;
    this.progressCounters.set(nodeId, info);

    const percent = Math.floor((info.current / total) * 100);
    this.updateProgress(nodeId, percent, message);
  }

  /**
   * Update progress and emit SSE event
   */
  updateProgress(nodeId: string, progress: number, message?: string): void {
    this.status.progress = progress;
    this.status.currentStep = nodeId;

    const event: ProgressEvent = {
      nodeId,
      state: {
        progress,
        currentStep: nodeId,
        message,
      },
      timestamp: Date.now(),
    };

    // Log sparingly to avoid flooding (only every 10% or on complete)
    // But for now detailed log is requested
    const logMsg = `[WorkflowRunner] Emitting progress: ${nodeId} (${progress}%) - ${message}`;
    console.log(logMsg);
    this.logToFile(`[${new Date().toISOString()}] ${logMsg}`);

    this.emit(SSE_EVENTS.progress, event);
  }

  /**
   * Mark workflow as complete
   */
  complete(result?: any): void {
    this.status = {
      isRunning: false,
      progress: 100,
      currentStep: null,
      phase: WORKFLOW_PHASES.complete,
    };

    const logMsg = "[WorkflowRunner] Emitting complete";
    console.log(logMsg);
    this.logToFile(`[${new Date().toISOString()}] ${logMsg}`);

    this.emit(SSE_EVENTS.complete, {
      nodeId: "complete",
      state: {
        progress: 100,
        currentStep: "complete",
        result,
      },
      timestamp: Date.now(),
    });
  }

  /**
   * Mark workflow as failed
   */
  error(errorMessage: string): void {
    this.status = {
      isRunning: false,
      progress: this.status.progress,
      currentStep: this.status.currentStep,
      phase: WORKFLOW_PHASES.error,
      error: errorMessage,
    };

    const logMsg = `[WorkflowRunner] Emitting error: ${errorMessage}`;
    console.error(logMsg);
    this.logToFile(`[${new Date().toISOString()}] ${logMsg}`);

    this.emit(SSE_EVENTS.workflowError, {
      nodeId: "error",
      state: {
        error: errorMessage,
      },
      timestamp: Date.now(),
    });
  }

  /**
   * Reset to idle state
   */
  reset(): void {
    this.status = {
      isRunning: false,
      progress: 0,
      currentStep: null,
      phase: WORKFLOW_PHASES.idle,
    };
  }
}

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

export interface RuntimeStatus {
  isRunning: boolean;
  progress: number;
  currentStep: string | null;
  phase: "idle" | "running" | "complete" | "error";
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
  private status: RuntimeStatus = {
    isRunning: false,
    progress: 0,
    currentStep: null,
    phase: "idle",
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
  }

  // ============ Runtime State ============

  isRunning(): boolean {
    return this.status.isRunning;
  }

  getStatus(): RuntimeStatus {
    return { ...this.status };
  }

  start(): void {
    this.status = {
      isRunning: true,
      progress: 0,
      currentStep: "starting",
      phase: "running",
    };
  }

  // ============ Progress Updates ============

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

    this.emit("progress", event);
  }

  /**
   * Mark workflow as complete
   */
  complete(result?: any): void {
    this.status = {
      isRunning: false,
      progress: 100,
      currentStep: null,
      phase: "complete",
    };

    this.emit("complete", {
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
      phase: "error",
      error: errorMessage,
    };

    this.emit("workflow_error", {
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
      phase: "idle",
    };
  }
}

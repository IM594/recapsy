/**
 * Checkpoint Manager - Handle persistence, resume capability, and SSE for summaries
 */

import fs from "fs/promises";
import path from "path";
import { EventEmitter } from "events";
import type {
  YearEndCheckpoint,
  DailyCommitData,
  DailySummary,
  MonthlySummary,
} from "./types";

const DEFAULT_OUTPUT_DIR = "./outputs";

// SSE Event types
export interface ProgressEvent {
  step: string;
  progress: number;
  message: string;
}

// Singleton instances to ensure SSE events reach the API listeners
const instancesByYear = new Map<number, CheckpointManager>();

export class CheckpointManager extends EventEmitter {
  private outputDir: string;
  private checkpointPath: string;
  private checkpoint: YearEndCheckpoint | null = null;
  private year: number;

  /**
   * Get or create a CheckpointManager instance for a specific year.
   * This is preferred over using `new` directly.
   */
  static getInstance(
    year: number,
    baseDir: string = DEFAULT_OUTPUT_DIR
  ): CheckpointManager {
    if (!instancesByYear.has(year)) {
      instancesByYear.set(year, new CheckpointManager(year, baseDir));
    }
    return instancesByYear.get(year)!;
  }

  constructor(year: number, baseDir: string = DEFAULT_OUTPUT_DIR) {
    super();
    this.year = year;
    this.outputDir = path.join(baseDir, `year-end-${year}`);
    this.checkpointPath = path.join(this.outputDir, "checkpoint.json");
  }

  /**
   * Initialize output directory structure
   */
  async initialize(repos: string[], authorPattern: string): Promise<void> {
    // Create directories
    await fs.mkdir(path.join(this.outputDir, "raw"), { recursive: true });
    await fs.mkdir(path.join(this.outputDir, "daily"), { recursive: true });
    await fs.mkdir(path.join(this.outputDir, "weekly"), { recursive: true });
    await fs.mkdir(path.join(this.outputDir, "monthly"), { recursive: true });

    // Load or create checkpoint
    try {
      const data = await fs.readFile(this.checkpointPath, "utf-8");
      this.checkpoint = JSON.parse(data);
      console.log(
        `[Checkpoint] Loaded existing checkpoint from ${this.checkpointPath}`
      );
    } catch {
      // Create new checkpoint
      const year = parseInt(
        path.basename(this.outputDir).replace("year-end-", "")
      );
      this.checkpoint = {
        year,
        repos,
        authorPattern,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isRunning: false,
        currentStep: null,
        progress: 0,
        phase: "idle",
        collectedDates: [],
        dailySummariesCompleted: [],
        weeklySummariesCompleted: [],
        monthlySummariesCompleted: [],
        errors: [],
      };
      await this.save();
      console.log(
        `[Checkpoint] Created new checkpoint at ${this.checkpointPath}`
      );
    }
  }

  /**
   * Save checkpoint to disk
   */
  async save(): Promise<void> {
    if (!this.checkpoint) return;
    this.checkpoint.updatedAt = new Date().toISOString();
    await fs.writeFile(
      this.checkpointPath,
      JSON.stringify(this.checkpoint, null, 2)
    );
  }

  /**
   * Get current checkpoint state
   */
  getCheckpoint(): YearEndCheckpoint | null {
    return this.checkpoint;
  }

  // ============ Runtime State (SSE support) ============

  /**
   * Check if a task is currently running
   */
  isRunning(): boolean {
    return this.checkpoint?.isRunning ?? false;
  }

  /**
   * Set running state
   */
  async setRunning(running: boolean): Promise<void> {
    if (this.checkpoint) {
      this.checkpoint.isRunning = running;
      if (!running) {
        this.checkpoint.currentStep = null;
      }
      await this.save();
    }
  }

  /**
   * Update progress and emit SSE event
   */
  async updateProgress(
    step: string,
    progress: number,
    message: string
  ): Promise<void> {
    if (this.checkpoint) {
      this.checkpoint.currentStep = step;
      this.checkpoint.progress = progress;
      await this.save();
    }

    // Emit SSE event
    this.emit("progress", { step, progress, message } as ProgressEvent);
  }

  /**
   * Mark task as complete and emit event
   */
  async markComplete(result?: any): Promise<void> {
    if (this.checkpoint) {
      this.checkpoint.isRunning = false;
      this.checkpoint.phase = "complete";
      this.checkpoint.progress = 100;
      this.checkpoint.currentStep = null;
      await this.save();
    }
    this.emit("complete", result);
  }

  /**
   * Mark task as failed and emit event
   */
  async markError(error: string): Promise<void> {
    if (this.checkpoint) {
      this.checkpoint.isRunning = false;
      this.checkpoint.phase = "error";
      await this.save();
    }
    this.emit("error", error);
  }

  /**
   * Get current status for API
   */
  getStatus(): {
    isRunning: boolean;
    phase: string;
    progress: number;
    currentStep: string | null;
  } {
    return {
      isRunning: this.checkpoint?.isRunning ?? false,
      phase: this.checkpoint?.phase ?? "idle",
      progress: this.checkpoint?.progress ?? 0,
      currentStep: this.checkpoint?.currentStep ?? null,
    };
  }

  /**
   * Update phase
   */
  async setPhase(phase: YearEndCheckpoint["phase"]): Promise<void> {
    if (this.checkpoint) {
      this.checkpoint.phase = phase;
      await this.save();
    }
  }

  /**
   * Reset status to idle (for regeneration)
   * Keeps all data but clears running state
   */
  async resetStatus(): Promise<void> {
    if (this.checkpoint) {
      this.checkpoint.isRunning = false;
      this.checkpoint.phase = "idle";
      this.checkpoint.progress = 0;
      this.checkpoint.currentStep = null;
      await this.save();
    }
  }

  // ============ Raw Data ============

  /**
   * Save raw commit data for a date-repo combination
   */
  async saveRawData(
    date: string,
    repo: string,
    data: DailyCommitData
  ): Promise<void> {
    const key = `${date}-${repo}`;
    const filePath = path.join(this.outputDir, "raw", `commits-${key}.json`);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));

    if (this.checkpoint && !this.checkpoint.collectedDates.includes(key)) {
      this.checkpoint.collectedDates.push(key);
      await this.save();
    }
  }

  /**
   * Load raw data for a date-repo combination
   */
  async loadRawData(
    date: string,
    repo: string
  ): Promise<DailyCommitData | null> {
    try {
      const key = `${date}-${repo}`;
      const filePath = path.join(this.outputDir, "raw", `commits-${key}.json`);
      const data = await fs.readFile(filePath, "utf-8");
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Check if raw data exists for a date-repo
   */
  hasRawData(date: string, repo: string): boolean {
    const key = `${date}-${repo}`;
    return this.checkpoint?.collectedDates.includes(key) ?? false;
  }

  // ============ Daily Summaries ============

  /**
   * Save daily summary (with repo in filename)
   */
  async saveDailySummary(summary: DailySummary): Promise<void> {
    const key = `${summary.date}-${summary.repo}`;
    const filePath = path.join(this.outputDir, "daily", `${key}.md`);
    await fs.writeFile(filePath, summary.summary);

    // Also save JSON version for programmatic access
    const jsonPath = path.join(this.outputDir, "daily", `${key}.json`);
    await fs.writeFile(jsonPath, JSON.stringify(summary, null, 2));

    if (
      this.checkpoint &&
      !this.checkpoint.dailySummariesCompleted.includes(key)
    ) {
      this.checkpoint.dailySummariesCompleted.push(key);
      await this.save();
    }
  }

  /**
   * Load daily summary
   */
  async loadDailySummary(
    date: string,
    repo?: string
  ): Promise<DailySummary | null> {
    try {
      const key = repo ? `${date}-${repo}` : date;
      const jsonPath = path.join(this.outputDir, "daily", `${key}.json`);
      const data = await fs.readFile(jsonPath, "utf-8");
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Check if daily summary exists for a date-repo
   */
  hasDailySummary(date: string, repo: string): boolean {
    const key = `${date}-${repo}`;
    return this.checkpoint?.dailySummariesCompleted.includes(key) ?? false;
  }

  /**
   * Get all completed daily summaries
   */
  async loadAllDailySummaries(): Promise<DailySummary[]> {
    const summaries: DailySummary[] = [];
    const keys = this.checkpoint?.dailySummariesCompleted ?? [];

    for (const key of keys) {
      try {
        const jsonPath = path.join(this.outputDir, "daily", `${key}.json`);
        const data = await fs.readFile(jsonPath, "utf-8");
        summaries.push(JSON.parse(data));
      } catch {
        // Skip missing files
      }
    }

    return summaries.sort((a, b) => a.date.localeCompare(b.date));
  }

  // ============ Weekly Summaries ============

  /**
   * Save weekly summary
   */
  async saveWeeklySummary(summary: any): Promise<void> {
    const key = `${summary.weekStart}`;
    const safeKey = encodeURIComponent(key);
    const filePath = path.join(this.outputDir, "weekly", `${safeKey}.md`);
    await fs.writeFile(filePath, summary.summary);

    const jsonPath = path.join(this.outputDir, "weekly", `${safeKey}.json`);
    await fs.writeFile(jsonPath, JSON.stringify(summary, null, 2));

    if (
      this.checkpoint &&
      !this.checkpoint.weeklySummariesCompleted?.includes(key)
    ) {
      if (!this.checkpoint.weeklySummariesCompleted) {
        this.checkpoint.weeklySummariesCompleted = [];
      }
      this.checkpoint.weeklySummariesCompleted.push(key);
      await this.save();
    }
  }

  /**
   * Load weekly summary
   */
  async loadWeeklySummary(weekStart: string): Promise<any | null> {
    try {
      const safeKey = encodeURIComponent(weekStart);
      const jsonPath = path.join(this.outputDir, "weekly", `${safeKey}.json`);
      const data = await fs.readFile(jsonPath, "utf-8");
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Check if weekly summary exists
   */
  hasWeeklySummary(weekStart: string): boolean {
    return (
      this.checkpoint?.weeklySummariesCompleted?.includes(weekStart) ?? false
    );
  }

  /**
   * Get all completed weekly summaries
   */
  async loadAllWeeklySummaries(): Promise<any[]> {
    const summaries: any[] = [];
    const keys = this.checkpoint?.weeklySummariesCompleted ?? [];

    for (const key of keys) {
      try {
        const safeKey = encodeURIComponent(key);
        const jsonPath = path.join(this.outputDir, "weekly", `${safeKey}.json`);
        const data = await fs.readFile(jsonPath, "utf-8");
        summaries.push(JSON.parse(data));
      } catch {
        // Skip missing files
      }
    }

    return summaries.sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  }

  // ============ Monthly Summaries ============

  /**
   * Save monthly summary
   */
  async saveMonthlySummary(summary: MonthlySummary): Promise<void> {
    const filePath = path.join(
      this.outputDir,
      "monthly",
      `${summary.month}.md`
    );
    await fs.writeFile(filePath, summary.summary);

    const jsonPath = path.join(
      this.outputDir,
      "monthly",
      `${summary.month}.json`
    );
    await fs.writeFile(jsonPath, JSON.stringify(summary, null, 2));

    if (
      this.checkpoint &&
      !this.checkpoint.monthlySummariesCompleted.includes(summary.month)
    ) {
      this.checkpoint.monthlySummariesCompleted.push(summary.month);
      await this.save();
    }
  }

  /**
   * Load monthly summary
   */
  async loadMonthlySummary(month: string): Promise<MonthlySummary | null> {
    try {
      const jsonPath = path.join(this.outputDir, "monthly", `${month}.json`);
      const data = await fs.readFile(jsonPath, "utf-8");
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Check if monthly summary exists
   */
  hasMonthlySummary(month: string): boolean {
    return this.checkpoint?.monthlySummariesCompleted.includes(month) ?? false;
  }

  /**
   * Get all completed monthly summaries
   */
  async loadAllMonthlySummaries(): Promise<MonthlySummary[]> {
    const summaries: MonthlySummary[] = [];
    const months = this.checkpoint?.monthlySummariesCompleted ?? [];

    for (const month of months) {
      const summary = await this.loadMonthlySummary(month);
      if (summary) {
        summaries.push(summary);
      }
    }

    return summaries.sort((a, b) => a.month.localeCompare(b.month));
  }

  // ============ Final Summary ============

  /**
   * Save year-end summary
   */
  async saveYearEndSummary(summary: string): Promise<void> {
    const filePath = path.join(this.outputDir, "year-end-summary.md");
    await fs.writeFile(filePath, summary);

    if (this.checkpoint) {
      this.checkpoint.phase = "complete";
      await this.save();
    }
  }

  /**
   * Load year-end summary
   */
  async loadYearEndSummary(): Promise<string | null> {
    try {
      const filePath = path.join(this.outputDir, "year-end-summary.md");
      return await fs.readFile(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  // ============ Error Handling ============

  /**
   * Record an error
   */
  async recordError(date: string, phase: string, error: string): Promise<void> {
    if (this.checkpoint) {
      this.checkpoint.errors.push({
        date,
        phase,
        error,
        timestamp: new Date().toISOString(),
      });
      await this.save();
    }
  }

  /**
   * Get output directory path
   */
  getOutputDir(): string {
    return this.outputDir;
  }
}

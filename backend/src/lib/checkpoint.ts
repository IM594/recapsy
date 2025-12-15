/**
 * Checkpoint Manager - Handle persistence and resume capability for year-end summary
 */

import fs from "fs/promises";
import path from "path";
import type {
  YearEndCheckpoint,
  DailyCommitData,
  DailySummary,
  MonthlySummary,
} from "./types";

const DEFAULT_OUTPUT_DIR = "./outputs";

export class CheckpointManager {
  private outputDir: string;
  private checkpointPath: string;
  private checkpoint: YearEndCheckpoint | null = null;

  constructor(year: number, baseDir: string = DEFAULT_OUTPUT_DIR) {
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
        phase: "collecting",
        collectedDates: [],
        dailySummariesCompleted: [],
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

  /**
   * Update phase
   */
  async setPhase(phase: YearEndCheckpoint["phase"]): Promise<void> {
    if (this.checkpoint) {
      this.checkpoint.phase = phase;
      await this.save();
    }
  }

  // ============ Raw Data ============

  /**
   * Save raw commit data for a date
   */
  async saveRawData(date: string, data: DailyCommitData): Promise<void> {
    const filePath = path.join(this.outputDir, "raw", `commits-${date}.json`);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));

    if (this.checkpoint && !this.checkpoint.collectedDates.includes(date)) {
      this.checkpoint.collectedDates.push(date);
      await this.save();
    }
  }

  /**
   * Load raw data for a date
   */
  async loadRawData(date: string): Promise<DailyCommitData | null> {
    try {
      const filePath = path.join(this.outputDir, "raw", `commits-${date}.json`);
      const data = await fs.readFile(filePath, "utf-8");
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Check if raw data exists for a date
   */
  hasRawData(date: string): boolean {
    return this.checkpoint?.collectedDates.includes(date) ?? false;
  }

  // ============ Daily Summaries ============

  /**
   * Save daily summary
   */
  async saveDailySummary(summary: DailySummary): Promise<void> {
    const filePath = path.join(this.outputDir, "daily", `${summary.date}.md`);
    await fs.writeFile(filePath, summary.summary);

    // Also save JSON version for programmatic access
    const jsonPath = path.join(this.outputDir, "daily", `${summary.date}.json`);
    await fs.writeFile(jsonPath, JSON.stringify(summary, null, 2));

    if (
      this.checkpoint &&
      !this.checkpoint.dailySummariesCompleted.includes(summary.date)
    ) {
      this.checkpoint.dailySummariesCompleted.push(summary.date);
      await this.save();
    }
  }

  /**
   * Load daily summary
   */
  async loadDailySummary(date: string): Promise<DailySummary | null> {
    try {
      const jsonPath = path.join(this.outputDir, "daily", `${date}.json`);
      const data = await fs.readFile(jsonPath, "utf-8");
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Check if daily summary exists for a date
   */
  hasDailySummary(date: string): boolean {
    return this.checkpoint?.dailySummariesCompleted.includes(date) ?? false;
  }

  /**
   * Get all completed daily summaries
   */
  async loadAllDailySummaries(): Promise<DailySummary[]> {
    const summaries: DailySummary[] = [];
    const dates = this.checkpoint?.dailySummariesCompleted ?? [];

    for (const date of dates) {
      const summary = await this.loadDailySummary(date);
      if (summary) {
        summaries.push(summary);
      }
    }

    return summaries.sort((a, b) => a.date.localeCompare(b.date));
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

/**
 * SummaryStore - Pure data persistence for generated summaries
 *
 * This replaces the old CheckpointManager's data storage responsibility.
 * Runtime state (isRunning, progress) is NOT stored - it's ephemeral.
 *
 * Storage structure:
 *   outputs/year-end-{year}/
 *     ├── raw/          - Git commit data
 *     ├── daily/        - Daily summaries
 *     ├── weekly/       - Weekly summaries
 *     ├── monthly/      - Monthly summaries
 *     └── index.json    - Cache index (what's been generated)
 */

import fs from "fs/promises";
import path from "path";
import type {
  DailyCommitData,
  DailySummary,
  MonthlySummary,
  WeeklySummary,
} from "./types";
import { getBaseOutputDir } from "./paths";

interface CacheIndex {
  year: number;
  repos: string[];
  authorPattern: string;
  createdAt: string;
  updatedAt: string;
  // Cache keys for what's been generated
  collectedDates: string[]; // "YYYY-MM-DD-repoName"
  dailySummaries: string[]; // "YYYY-MM-DD-repoName"
  weeklySummaries: string[]; // "YYYY-MM-DD" (week start)
  monthlySummaries: string[]; // "YYYY-MM"
  hasYearEndSummary: boolean;
}

// Singleton instances by year
const instancesByYear = new Map<number, SummaryStore>();

export class SummaryStore {
  private outputDir: string;
  private indexPath: string;
  private index: CacheIndex | null = null;
  private year: number;

  static getInstance(
    year: number,
    baseDir: string = getBaseOutputDir()
  ): SummaryStore {
    if (!instancesByYear.has(year)) {
      instancesByYear.set(year, new SummaryStore(year, baseDir));
    }
    return instancesByYear.get(year)!;
  }

  constructor(year: number, baseDir: string = getBaseOutputDir()) {
    this.year = year;
    this.outputDir = path.join(baseDir, `year-end-${year}`);
    this.indexPath = path.join(this.outputDir, "index.json");
  }

  /**
   * Initialize directories and load/create index
   */
  async initialize(repos: string[], authorPattern: string): Promise<void> {
    await fs.mkdir(path.join(this.outputDir, "raw"), { recursive: true });
    await fs.mkdir(path.join(this.outputDir, "daily"), { recursive: true });
    await fs.mkdir(path.join(this.outputDir, "weekly"), { recursive: true });
    await fs.mkdir(path.join(this.outputDir, "monthly"), { recursive: true });

    try {
      const data = await fs.readFile(this.indexPath, "utf-8");
      this.index = JSON.parse(data);
      console.log(`[SummaryStore] Loaded index from ${this.indexPath}`);
    } catch {
      this.index = {
        year: this.year,
        repos,
        authorPattern,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        collectedDates: [],
        dailySummaries: [],
        weeklySummaries: [],
        monthlySummaries: [],
        hasYearEndSummary: false,
      };
      await this.saveIndex();
      console.log(`[SummaryStore] Created new index at ${this.indexPath}`);
    }
  }

  /**
   * Load index if exists (for read-only access)
   */
  async loadIfExists(): Promise<boolean> {
    if (this.index) return true;
    try {
      const data = await fs.readFile(this.indexPath, "utf-8");
      this.index = JSON.parse(data);
      return true;
    } catch {
      return false;
    }
  }

  private async saveIndex(): Promise<void> {
    if (!this.index) return;
    this.index.updatedAt = new Date().toISOString();
    await fs.writeFile(this.indexPath, JSON.stringify(this.index, null, 2));
  }

  // ============ Raw Data ============

  async saveRawData(
    date: string,
    repo: string,
    data: DailyCommitData
  ): Promise<void> {
    const key = `${date}-${repo}`;
    const filePath = path.join(this.outputDir, "raw", `commits-${key}.json`);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));

    if (this.index && !this.index.collectedDates.includes(key)) {
      this.index.collectedDates.push(key);
      await this.saveIndex();
    }
  }

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

  hasRawData(date: string, repo: string): boolean {
    const key = `${date}-${repo}`;
    return this.index?.collectedDates.includes(key) ?? false;
  }

  // ============ Daily Summaries ============

  async saveDailySummary(summary: DailySummary): Promise<void> {
    const key = `${summary.date}-${summary.repo}`;
    const filePath = path.join(this.outputDir, "daily", `${key}.md`);
    await fs.writeFile(filePath, summary.summary);

    const jsonPath = path.join(this.outputDir, "daily", `${key}.json`);
    await fs.writeFile(jsonPath, JSON.stringify(summary, null, 2));

    if (this.index && !this.index.dailySummaries.includes(key)) {
      this.index.dailySummaries.push(key);
      await this.saveIndex();
    }
  }

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

  hasDailySummary(date: string, repo: string): boolean {
    const key = `${date}-${repo}`;
    return this.index?.dailySummaries.includes(key) ?? false;
  }

  async loadAllDailySummaries(): Promise<DailySummary[]> {
    const summaries: DailySummary[] = [];
    const keys = this.index?.dailySummaries ?? [];

    for (const key of keys) {
      try {
        const jsonPath = path.join(this.outputDir, "daily", `${key}.json`);
        const data = await fs.readFile(jsonPath, "utf-8");
        summaries.push(JSON.parse(data));
      } catch {
        // Skip missing
      }
    }
    return summaries.sort((a, b) => a.date.localeCompare(b.date));
  }

  // ============ Weekly Summaries ============

  async saveWeeklySummary(summary: WeeklySummary): Promise<void> {
    const key = summary.weekStart;
    const safeKey = encodeURIComponent(key);
    const filePath = path.join(this.outputDir, "weekly", `${safeKey}.md`);
    await fs.writeFile(filePath, summary.summary);

    const jsonPath = path.join(this.outputDir, "weekly", `${safeKey}.json`);
    await fs.writeFile(jsonPath, JSON.stringify(summary, null, 2));

    if (this.index && !this.index.weeklySummaries.includes(key)) {
      this.index.weeklySummaries.push(key);
      await this.saveIndex();
    }
  }

  async loadWeeklySummary(weekStart: string): Promise<WeeklySummary | null> {
    try {
      const safeKey = encodeURIComponent(weekStart);
      const jsonPath = path.join(this.outputDir, "weekly", `${safeKey}.json`);
      const data = await fs.readFile(jsonPath, "utf-8");
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  hasWeeklySummary(weekStart: string): boolean {
    return this.index?.weeklySummaries.includes(weekStart) ?? false;
  }

  async loadAllWeeklySummaries(): Promise<WeeklySummary[]> {
    const summaries: WeeklySummary[] = [];
    const keys = this.index?.weeklySummaries ?? [];

    for (const key of keys) {
      try {
        const safeKey = encodeURIComponent(key);
        const jsonPath = path.join(this.outputDir, "weekly", `${safeKey}.json`);
        const data = await fs.readFile(jsonPath, "utf-8");
        summaries.push(JSON.parse(data));
      } catch {
        // Skip missing
      }
    }
    return summaries.sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  }

  // ============ Monthly Summaries ============

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

    if (this.index && !this.index.monthlySummaries.includes(summary.month)) {
      this.index.monthlySummaries.push(summary.month);
      await this.saveIndex();
    }
  }

  async loadMonthlySummary(month: string): Promise<MonthlySummary | null> {
    try {
      const jsonPath = path.join(this.outputDir, "monthly", `${month}.json`);
      const data = await fs.readFile(jsonPath, "utf-8");
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  hasMonthlySummary(month: string): boolean {
    return this.index?.monthlySummaries.includes(month) ?? false;
  }

  async loadAllMonthlySummaries(): Promise<MonthlySummary[]> {
    const summaries: MonthlySummary[] = [];
    const months = this.index?.monthlySummaries ?? [];

    for (const month of months) {
      const summary = await this.loadMonthlySummary(month);
      if (summary) summaries.push(summary);
    }
    return summaries.sort((a, b) => a.month.localeCompare(b.month));
  }

  // ============ Year-End Summary ============

  async saveYearEndSummary(summary: string): Promise<void> {
    const filePath = path.join(this.outputDir, "year-end-summary.md");
    await fs.writeFile(filePath, summary);

    if (this.index) {
      this.index.hasYearEndSummary = true;
      await this.saveIndex();
    }
  }

  async loadYearEndSummary(): Promise<string | null> {
    try {
      const filePath = path.join(this.outputDir, "year-end-summary.md");
      return await fs.readFile(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  hasYearEndSummary(): boolean {
    return this.index?.hasYearEndSummary ?? false;
  }

  // ============ Utilities ============

  getOutputDir(): string {
    return this.outputDir;
  }

  getIndex(): CacheIndex | null {
    return this.index;
  }
}

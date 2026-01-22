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
import logger from "./logger";

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

  private isErrnoException(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error;
  }

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

  private async safeReadDir(dirPath: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => e.name);
    } catch (error) {
      if (this.isErrnoException(error) && error.code === "ENOENT") return [];
      logger.error("SummaryStore: failed to read directory", error instanceof Error ? error : undefined);
      logger.debug("dirPath", dirPath);
      return [];
    }
  }

  private async rebuildIndexFromDisk(opts: {
    repos: string[];
    authorPattern: string;
    createdAt?: string;
  }): Promise<CacheIndex> {
    const now = new Date().toISOString();
    const createdAt = opts.createdAt || now;

    const rawFiles = await this.safeReadDir(path.join(this.outputDir, "raw"));
    const dailyFiles = await this.safeReadDir(path.join(this.outputDir, "daily"));
    const weeklyFiles = await this.safeReadDir(path.join(this.outputDir, "weekly"));
    const monthlyFiles = await this.safeReadDir(path.join(this.outputDir, "monthly"));

    const collectedDates = rawFiles
      .filter((name) => name.startsWith("commits-") && name.endsWith(".json"))
      .map((name) => name.slice("commits-".length, -".json".length));

    const dailySummaries = dailyFiles
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));

    const weeklySummaries = weeklyFiles
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const base = name.slice(0, -".json".length);
        try {
          return decodeURIComponent(base);
        } catch {
          return base;
        }
      });

    const monthlySummaries = monthlyFiles
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));

    const hasYearEndSummary = await fs
      .access(path.join(this.outputDir, "year-end-summary.md"))
      .then(() => true)
      .catch((error) => {
        if (this.isErrnoException(error) && error.code === "ENOENT") return false;
        logger.error(
          "SummaryStore: failed to check year-end summary file",
          error instanceof Error ? error : undefined
        );
        return false;
      });

    return {
      year: this.year,
      repos: opts.repos,
      authorPattern: opts.authorPattern,
      createdAt,
      updatedAt: now,
      collectedDates: Array.from(new Set(collectedDates)).sort(),
      dailySummaries: Array.from(new Set(dailySummaries)).sort(),
      weeklySummaries: Array.from(new Set(weeklySummaries)).sort(),
      monthlySummaries: Array.from(new Set(monthlySummaries)).sort(),
      hasYearEndSummary,
    };
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
      logger.info(`SummaryStore: loaded index (year=${this.year})`);
      logger.debug("indexPath", this.indexPath);
    } catch (error) {
      if (this.isErrnoException(error) && error.code === "ENOENT") {
        logger.info(`SummaryStore: index missing; rebuilding (year=${this.year})`);
      } else {
        logger.warn(`SummaryStore: failed to read index; rebuilding (year=${this.year})`);
        logger.error(
          "SummaryStore: index read error",
          error instanceof Error ? error : undefined
        );
      }

      this.index = await this.rebuildIndexFromDisk({ repos, authorPattern });
      await this.saveIndex();
      logger.info(`SummaryStore: index saved (year=${this.year})`);
      logger.debug("indexPath", this.indexPath);
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
    } catch (error) {
      if (this.isErrnoException(error) && error.code === "ENOENT") {
        // If index is missing but the year directory exists, rebuild so the UI can still read data.
        const rebuilt = await this.rebuildIndexFromDisk({
          repos: [],
          authorPattern: "",
        });
        const hasAnyData =
          rebuilt.collectedDates.length > 0 ||
          rebuilt.dailySummaries.length > 0 ||
          rebuilt.weeklySummaries.length > 0 ||
          rebuilt.monthlySummaries.length > 0 ||
          rebuilt.hasYearEndSummary;
        if (!hasAnyData) return false;

        this.index = rebuilt;
        await this.saveIndex();
        logger.info(`SummaryStore: index rebuilt for read-only (year=${this.year})`);
        return true;
      }

      logger.warn(`SummaryStore: failed to load index (year=${this.year})`);
      logger.error(
        "SummaryStore: loadIfExists error",
        error instanceof Error ? error : undefined
      );
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
    } catch (error) {
      if (this.isErrnoException(error) && error.code === "ENOENT") return null;
      logger.warn("SummaryStore: failed to load raw data");
      logger.error("SummaryStore: loadRawData error", error instanceof Error ? error : undefined);
      logger.debug("rawKey", `${date}-${repo}`);
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
    } catch (error) {
      if (this.isErrnoException(error) && error.code === "ENOENT") return null;
      logger.warn("SummaryStore: failed to load daily summary");
      logger.error(
        "SummaryStore: loadDailySummary error",
        error instanceof Error ? error : undefined
      );
      logger.debug("dailyKey", repo ? `${date}-${repo}` : date);
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
      } catch (error) {
        if (this.isErrnoException(error) && error.code === "ENOENT") continue;
        logger.warn("SummaryStore: failed to load daily summary from index key");
        logger.error(
          "SummaryStore: loadAllDailySummaries error",
          error instanceof Error ? error : undefined
        );
        logger.debug("dailyKey", key);
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
    } catch (error) {
      if (this.isErrnoException(error) && error.code === "ENOENT") return null;
      logger.warn("SummaryStore: failed to load weekly summary");
      logger.error(
        "SummaryStore: loadWeeklySummary error",
        error instanceof Error ? error : undefined
      );
      logger.debug("weekStart", weekStart);
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
      } catch (error) {
        if (this.isErrnoException(error) && error.code === "ENOENT") continue;
        logger.warn("SummaryStore: failed to load weekly summary from index key");
        logger.error(
          "SummaryStore: loadAllWeeklySummaries error",
          error instanceof Error ? error : undefined
        );
        logger.debug("weekStart", key);
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
    } catch (error) {
      if (this.isErrnoException(error) && error.code === "ENOENT") return null;
      logger.warn("SummaryStore: failed to load monthly summary");
      logger.error(
        "SummaryStore: loadMonthlySummary error",
        error instanceof Error ? error : undefined
      );
      logger.debug("month", month);
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
    } catch (error) {
      if (this.isErrnoException(error) && error.code === "ENOENT") return null;
      logger.warn("SummaryStore: failed to load year-end summary");
      logger.error(
        "SummaryStore: loadYearEndSummary error",
        error instanceof Error ? error : undefined
      );
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

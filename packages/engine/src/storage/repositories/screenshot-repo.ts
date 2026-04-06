import type { Surreal } from "surrealdb";
import { StringRecordId } from "surrealdb";
import { screenshotSchema, type Screenshot, type ScreenshotCreate } from "@recaply/shared";
import type { Logger } from "../../utils/logger";
import { NotFoundError, StorageError } from "../../utils/errors";
import { normalizeRow } from "../utils";

export interface ScreenshotRepo {
  create(data: ScreenshotCreate): Promise<Screenshot>;
  findById(id: string): Promise<Screenshot>;
  findByTimeRange(start: Date, end: Date): Promise<Screenshot[]>;
  findByApp(bundleId: string, limit?: number): Promise<Screenshot[]>;
  findByCaptureId(captureId: string): Promise<Screenshot | undefined>;
  updateStatus(id: string, status: string, error?: string): Promise<void>;
  count(): Promise<number>;
}

export interface ScreenshotRepoDeps {
  db: Surreal;
  logger: Logger;
}

export function createScreenshotRepo(deps: ScreenshotRepoDeps): ScreenshotRepo {
  const { db, logger: parentLogger } = deps;
  const logger = parentLogger.child({ module: "screenshot-repo" });

  function parseRow(row: unknown): Screenshot {
    const normalized = normalizeRow(row as Record<string, unknown>);
    const result = screenshotSchema.safeParse(normalized);
    if (!result.success) {
      logger.warn({ error: result.error, row }, "failed to parse screenshot row");
      throw new StorageError("invalid screenshot data from database");
    }
    return result.data;
  }

  function parseRows(rows: unknown): Screenshot[] {
    if (!Array.isArray(rows)) return [];
    return rows.map(parseRow);
  }

  return {
    async create(data) {
      try {
        // Build content object, omitting undefined/null optional fields
        // SurrealDB option<T> expects NONE (field absent), not NULL
        const content: Record<string, unknown> = {
          path: data.path,
          timestamp: data.timestamp,
          app_name: data.app_name,
          bundle_id: data.bundle_id,
          window_title: data.window_title,
          display_id: data.display_id,
          is_active: data.is_active,
          diff_ratio: data.diff_ratio,
          resolution: data.resolution,
          file_size: data.file_size,
          status: data.status ?? "queued",
          capture_id: data.capture_id,
          timezone: data.timezone,
          local_date: data.local_date,
          local_hour: data.local_hour,
        };
        if (data.ocr_text != null) content.ocr_text = data.ocr_text;
        if (data.ocr_text_tokenized != null) content.ocr_text_tokenized = data.ocr_text_tokenized;

        const [rows] = await db.query<[Screenshot[]]>(
          "CREATE screenshot CONTENT $content",
          { content },
        );
        return parseRow(rows?.[0]);
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new StorageError("failed to create screenshot", error);
      }
    },

    async findById(id) {
      try {
        const [rows] = await db.query<[Screenshot[]]>(
          "SELECT * FROM screenshot WHERE id = $id",
          { id: new StringRecordId(id) },
        );
        const row = rows?.[0];
        if (!row) throw new NotFoundError("screenshot", id);
        return parseRow(row);
      } catch (error) {
        if (error instanceof NotFoundError || error instanceof StorageError) throw error;
        throw new StorageError(`failed to find screenshot: ${id}`, error);
      }
    },

    async findByTimeRange(start, end) {
      try {
        const [rows] = await db.query<[Screenshot[]]>(
          "SELECT * FROM screenshot WHERE timestamp >= $start AND timestamp <= $end ORDER BY timestamp ASC",
          { start, end },
        );
        return parseRows(rows);
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new StorageError("failed to query screenshots by time range", error);
      }
    },

    async findByApp(bundleId, limit = 100) {
      try {
        const [rows] = await db.query<[Screenshot[]]>(
          "SELECT * FROM screenshot WHERE bundle_id = $bundleId ORDER BY timestamp DESC LIMIT $limit",
          { bundleId, limit },
        );
        return parseRows(rows);
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new StorageError("failed to query screenshots by app", error);
      }
    },

    async findByCaptureId(captureId) {
      try {
        const [rows] = await db.query<[Screenshot[]]>(
          "SELECT * FROM screenshot WHERE capture_id = $captureId LIMIT 1",
          { captureId },
        );
        const row = rows?.[0];
        return row ? parseRow(row) : undefined;
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new StorageError(`failed to find screenshot by capture_id: ${captureId}`, error);
      }
    },

    async updateStatus(id, status, error) {
      try {
        const retryIncrement = status === "queued" ? ", retry_count = retry_count + 1" : "";
        const errorClause = error !== undefined ? ", last_error = $error" : "";
        await db.query(
          `UPDATE $id SET status = $status${retryIncrement}${errorClause}`,
          { id: new StringRecordId(id), status, error: error ?? null },
        );
      } catch (err) {
        throw new StorageError(`failed to update screenshot status: ${id}`, err);
      }
    },

    async count() {
      try {
        const [rows] = await db.query<[{ count: number }[]]>(
          "SELECT count() AS count FROM screenshot GROUP ALL",
        );
        return rows?.[0]?.count ?? 0;
      } catch (error) {
        throw new StorageError("failed to count screenshots", error);
      }
    },
  };
}

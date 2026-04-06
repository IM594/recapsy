import type { Surreal } from "surrealdb";
import { StringRecordId } from "surrealdb";
import {
  activitySegmentSchema,
  type ActivitySegment,
  type ActivitySegmentCreate,
} from "@recaply/shared";
import type { Logger } from "../../utils/logger";
import { NotFoundError, StorageError } from "../../utils/errors";
import { normalizeRow } from "../utils";

export interface ActivitySegmentRepo {
  create(data: ActivitySegmentCreate): Promise<ActivitySegment>;
  findById(id: string): Promise<ActivitySegment>;
  findByTimeRange(start: Date, end: Date): Promise<ActivitySegment[]>;
  count(): Promise<number>;
}

export interface ActivitySegmentRepoDeps {
  db: Surreal;
  logger: Logger;
}

export function createActivitySegmentRepo(
  deps: ActivitySegmentRepoDeps,
): ActivitySegmentRepo {
  const { db, logger: parentLogger } = deps;
  const logger = parentLogger.child({ module: "activity-segment-repo" });

  function parseRow(row: unknown): ActivitySegment {
    const normalized = normalizeRow(row as Record<string, unknown>);
    const result = activitySegmentSchema.safeParse(normalized);
    if (!result.success) {
      logger.warn({ error: result.error, row }, "failed to parse activity segment row");
      throw new StorageError("invalid activity segment data from database");
    }
    return result.data;
  }

  function parseRows(rows: unknown): ActivitySegment[] {
    if (!Array.isArray(rows)) return [];
    return rows.map(parseRow);
  }

  return {
    async create(data) {
      try {
        const content: Record<string, unknown> = {
          app_name: data.app_name,
          bundle_id: data.bundle_id,
          display_ids: data.display_ids,
          session_start: data.session_start,
          session_end: data.session_end,
          duration_seconds: data.duration_seconds,
          activity: data.activity,
          scene_type: data.scene_type,
          summary: data.summary,
          visual_elements: data.visual_elements,
          key_entities: data.key_entities,
          screenshot_ids: data.screenshot_ids,
          frame_count: data.frame_count,
          selected_frame_count: data.selected_frame_count,
          timezone: data.timezone,
          local_date: data.local_date,
          llm_model: data.llm_model,
          llm_tokens_in: data.llm_tokens_in,
          llm_tokens_out: data.llm_tokens_out,
        };
        if (data.activity_tokenized != null) content.activity_tokenized = data.activity_tokenized;
        if (data.summary_tokenized != null) content.summary_tokenized = data.summary_tokenized;

        const [rows] = await db.query<[ActivitySegment[]]>(
          "CREATE activity_segment CONTENT $content",
          { content },
        );
        return parseRow(rows?.[0]);
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new StorageError("failed to create activity segment", error);
      }
    },

    async findById(id) {
      try {
        const [rows] = await db.query<[ActivitySegment[]]>(
          "SELECT * FROM activity_segment WHERE id = $id",
          { id: new StringRecordId(id) },
        );
        const row = rows?.[0];
        if (!row) throw new NotFoundError("activity_segment", id);
        return parseRow(row);
      } catch (error) {
        if (error instanceof NotFoundError || error instanceof StorageError) throw error;
        throw new StorageError(`failed to find activity segment: ${id}`, error);
      }
    },

    async findByTimeRange(start, end) {
      try {
        const [rows] = await db.query<[ActivitySegment[]]>(
          "SELECT * FROM activity_segment WHERE session_start >= $start AND session_start <= $end ORDER BY session_start ASC",
          { start, end },
        );
        return parseRows(rows);
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new StorageError("failed to query activity segments by time range", error);
      }
    },

    async count() {
      try {
        const [rows] = await db.query<[{ count: number }[]]>(
          "SELECT count() AS count FROM activity_segment GROUP ALL",
        );
        return rows?.[0]?.count ?? 0;
      } catch (error) {
        throw new StorageError("failed to count activity segments", error);
      }
    },
  };
}

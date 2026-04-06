import type { Surreal } from "surrealdb";
import { StringRecordId } from "surrealdb";
import {
  relationshipSchema,
  type Relationship,
  type RelationType,
} from "@recaply/shared";
import type { Logger } from "../../utils/logger";
import { StorageError } from "../../utils/errors";
import { normalizeRelationRow } from "../utils";

export interface RelationshipRepo {
  create(data: {
    inEntity: string;
    outEntity: string;
    relationType: RelationType;
    weight?: number;
    firstSeen: Date;
    lastSeen: Date;
  }): Promise<Relationship>;
  findByEntities(inId: string, outId: string, relationType?: RelationType): Promise<Relationship[]>;
  count(): Promise<number>;
}

export interface RelationshipRepoDeps {
  db: Surreal;
  logger: Logger;
}

export function createRelationshipRepo(deps: RelationshipRepoDeps): RelationshipRepo {
  const { db, logger: parentLogger } = deps;
  const logger = parentLogger.child({ module: "relationship-repo" });

  function parseRow(row: unknown): Relationship {
    const normalized = normalizeRelationRow(row as Record<string, unknown>);
    const result = relationshipSchema.safeParse(normalized);
    if (!result.success) {
      logger.warn({ error: result.error, row }, "failed to parse relationship row");
      throw new StorageError("invalid relationship data from database");
    }
    return result.data;
  }

  function parseRows(rows: unknown): Relationship[] {
    if (!Array.isArray(rows)) return [];
    return rows.map(parseRow);
  }

  return {
    async create(data) {
      try {
        const [rows] = await db.query<[Relationship[]]>(
          `RELATE $inEntity->related_to->$outEntity CONTENT {
            relation_type: $relationType,
            weight: $weight,
            first_seen: $firstSeen,
            last_seen: $lastSeen
          }`,
          {
            inEntity: new StringRecordId(data.inEntity),
            outEntity: new StringRecordId(data.outEntity),
            relationType: data.relationType,
            weight: data.weight ?? 1.0,
            firstSeen: data.firstSeen,
            lastSeen: data.lastSeen,
          },
        );
        return parseRow(rows?.[0]);
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new StorageError("failed to create relationship", error);
      }
    },

    async findByEntities(inId, outId, relationType) {
      try {
        const typeClause = relationType ? " AND relation_type = $relationType" : "";
        const [rows] = await db.query<[Relationship[]]>(
          `SELECT * FROM related_to WHERE in = $inId AND out = $outId${typeClause}`,
          { inId: new StringRecordId(inId), outId: new StringRecordId(outId), relationType },
        );
        return parseRows(rows);
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new StorageError("failed to find relationships", error);
      }
    },

    async count() {
      try {
        const [rows] = await db.query<[{ count: number }[]]>(
          "SELECT count() AS count FROM related_to GROUP ALL",
        );
        return rows?.[0]?.count ?? 0;
      } catch (error) {
        throw new StorageError("failed to count relationships", error);
      }
    },
  };
}

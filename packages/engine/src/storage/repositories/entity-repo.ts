import type { Surreal } from "surrealdb";
import { StringRecordId } from "surrealdb";
import { entitySchema, type Entity, type EntityCreate, type EntityType } from "@recaply/shared";
import type { Logger } from "../../utils/logger";
import { NotFoundError, StorageError } from "../../utils/errors";
import { normalizeRow } from "../utils";

export interface EntityRepo {
  create(data: EntityCreate): Promise<Entity>;
  findById(id: string): Promise<Entity>;
  findByTypeName(type: EntityType, name: string): Promise<Entity | undefined>;
  upsert(data: EntityCreate): Promise<Entity>;
  count(): Promise<number>;
}

export interface EntityRepoDeps {
  db: Surreal;
  logger: Logger;
}

export function createEntityRepo(deps: EntityRepoDeps): EntityRepo {
  const { db, logger: parentLogger } = deps;
  const logger = parentLogger.child({ module: "entity-repo" });

  function parseRow(row: unknown): Entity {
    const normalized = normalizeRow(row as Record<string, unknown>);
    const result = entitySchema.safeParse(normalized);
    if (!result.success) {
      logger.warn({ error: result.error, row }, "failed to parse entity row");
      throw new StorageError("invalid entity data from database");
    }
    return result.data;
  }

  return {
    async create(data) {
      try {
        const content: Record<string, unknown> = {
          type: data.type,
          name: data.name,
          first_seen: data.first_seen,
          last_seen: data.last_seen,
          frequency: data.frequency ?? 0,
        };
        if (data.aliases != null) content.aliases = data.aliases;
        if (data.metadata != null) content.metadata = data.metadata;

        const [rows] = await db.query<[Entity[]]>(
          "CREATE entity CONTENT $content",
          { content },
        );
        return parseRow(rows?.[0]);
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new StorageError("failed to create entity", error);
      }
    },

    async findById(id) {
      try {
        const [rows] = await db.query<[Entity[]]>(
          "SELECT * FROM entity WHERE id = $id",
          { id: new StringRecordId(id) },
        );
        const row = rows?.[0];
        if (!row) throw new NotFoundError("entity", id);
        return parseRow(row);
      } catch (error) {
        if (error instanceof NotFoundError || error instanceof StorageError) throw error;
        throw new StorageError(`failed to find entity: ${id}`, error);
      }
    },

    async findByTypeName(type, name) {
      try {
        const [rows] = await db.query<[Entity[]]>(
          "SELECT * FROM entity WHERE type = $type AND name = $name LIMIT 1",
          { type, name },
        );
        const row = rows?.[0];
        return row ? parseRow(row) : undefined;
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new StorageError(`failed to find entity by type+name: ${type}/${name}`, error);
      }
    },

    async upsert(data) {
      try {
        const existing = await this.findByTypeName(data.type, data.name);
        if (existing) {
          const setClauses = ["last_seen = $last_seen", "frequency = frequency + 1"];
          const params: Record<string, unknown> = {
            id: new StringRecordId(existing.id),
            last_seen: data.last_seen,
          };
          if (data.aliases != null) {
            setClauses.push("aliases = $aliases");
            params.aliases = data.aliases;
          }
          if (data.metadata != null) {
            setClauses.push("metadata = $metadata");
            params.metadata = data.metadata;
          }

          const [rows] = await db.query<[Entity[]]>(
            `UPDATE $id SET ${setClauses.join(", ")}`,
            params,
          );
          return parseRow(rows?.[0]);
        }
        return await this.create(data);
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new StorageError("failed to upsert entity", error);
      }
    },

    async count() {
      try {
        const [rows] = await db.query<[{ count: number }[]]>(
          "SELECT count() AS count FROM entity GROUP ALL",
        );
        return rows?.[0]?.count ?? 0;
      } catch (error) {
        throw new StorageError("failed to count entities", error);
      }
    },
  };
}

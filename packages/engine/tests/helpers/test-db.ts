import { Surreal } from "surrealdb";
import { createNodeEngines } from "@surrealdb/node";
import { allMigrations } from "../../src/storage/migrations";

let db: Surreal | null = null;

export async function setupTestDb(): Promise<Surreal> {
  db = new Surreal({ engines: createNodeEngines() });
  await db.connect("mem://");
  await db.use({ namespace: "test", database: "test" });

  // Run all migrations
  for (const migration of allMigrations) {
    await migration.up(db);
  }

  return db;
}

export async function cleanTestDb(): Promise<void> {
  if (!db) return;
  // Delete all data from tables (order matters for relations)
  await db.query(`
    DELETE appeared_in;
    DELETE appeared_in_segment;
    DELETE related_to;
    DELETE activity_segment;
    DELETE screenshot;
    DELETE entity;
    DELETE settings;
  `);
}

export async function teardownTestDb(): Promise<void> {
  if (!db) return;
  await db.close();
  db = null;
}

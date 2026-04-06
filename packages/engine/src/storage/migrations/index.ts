import { migration001 } from "./versions/001-initial";

export { createMigrationRunner } from "./runner";
export type { Migration, MigrationRunner } from "./runner";

export const allMigrations = [migration001];

import { DatabaseSync } from 'node:sqlite';
import type {
  SqliteDatabase,
  SqliteParameters,
  SqliteRow,
  SqliteRunResult,
  SqliteStatement,
  SqliteValue,
} from './sqlite-driver';

/**
 * `node:sqlite` backed implementation of `SqliteDatabase`.
 *
 * This is the driver the real Electron main process uses: Electron's main
 * process runs on Node (not Bun), so `bun-driver.ts` (which imports
 * `bun:sqlite`) cannot be loaded there. `node:sqlite`'s `DatabaseSync` speaks
 * the same synchronous, single-connection SQLite semantics `bun:sqlite`
 * does and needs the same positional-vs-named parameter handling, so this
 * mirrors `bun-driver.ts` structurally.
 *
 * `node:sqlite` is available without any native module rebuild starting
 * with the Node version bundled by current stable Electron releases, so it
 * avoids pulling in `better-sqlite3` and the native-module rebuild tooling
 * that would otherwise require for Electron.
 */
export function createNodeSqliteDatabase(path: string): SqliteDatabase {
  return new NodeSqliteDatabaseAdapter(path);
}

class NodeSqliteDatabaseAdapter implements SqliteDatabase {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
  }

  run(sql: string, parameters: SqliteParameters = []): SqliteRunResult {
    return this.prepare(sql).run(parameters);
  }

  prepare<Row extends SqliteRow = SqliteRow>(sql: string): SqliteStatement<Row> {
    const statement = this.database.prepare(sql);

    return {
      all: (parameters: SqliteParameters = []): Row[] =>
        (Array.isArray(parameters)
          ? statement.all(...parameters.map(normalizeBinding))
          : statement.all(namedBindings(parameters))) as Row[],
      get: (parameters: SqliteParameters = []): Row | null =>
        ((Array.isArray(parameters)
          ? statement.get(...parameters.map(normalizeBinding))
          : statement.get(namedBindings(parameters))) as Row | undefined) ?? null,
      run: (parameters: SqliteParameters = []): SqliteRunResult => {
        const result = Array.isArray(parameters)
          ? statement.run(...parameters.map(normalizeBinding))
          : statement.run(namedBindings(parameters));

        return {
          changes: Number(result.changes),
          lastInsertRowid: result.lastInsertRowid,
        };
      },
    };
  }

  close(): void {
    this.database.close();
  }
}

/**
 * `node:sqlite`'s bind types (`SQLInputValue`) do not include `boolean` even
 * though this driver's shared `SqliteValue` type does (to stay structurally
 * compatible with `bun-driver.ts`). SQLite itself has no boolean
 * column type, so booleans are normalized to `0`/`1` here, matching how
 * SQLite represents them everywhere else.
 */
type NodeSqliteBindableValue = Exclude<SqliteValue, boolean> | number;

function namedBindings(
  parameters: Record<string, SqliteValue>,
): Record<string, NodeSqliteBindableValue> {
  return Object.fromEntries(
    Object.entries(parameters).map(([key, value]) => [key, normalizeBinding(value)]),
  );
}

function normalizeBinding(value: SqliteValue): NodeSqliteBindableValue {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

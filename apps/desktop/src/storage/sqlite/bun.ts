import { Database } from 'bun:sqlite';
import type {
  SqliteDatabase,
  SqliteParameters,
  SqliteRow,
  SqliteStatement,
  SqliteValue,
} from './driver';

export function createBunSqliteDatabase(path: string): SqliteDatabase {
  return new BunSqliteDatabaseAdapter(path);
}

class BunSqliteDatabaseAdapter implements SqliteDatabase {
  private readonly database: Database;

  constructor(path: string) {
    this.database = new Database(path);
  }

  run(sql: string, parameters: SqliteParameters = []): ReturnType<SqliteDatabase['run']> {
    return this.prepare(sql).run(parameters);
  }

  prepare<Row extends SqliteRow = SqliteRow>(sql: string): SqliteStatement<Row> {
    const statement = this.database.prepare(sql);

    return {
      all: (parameters: SqliteParameters = []) =>
        statement.all(...toBunBindings(parameters)) as Row[],
      get: (parameters: SqliteParameters = []) =>
        (statement.get(...toBunBindings(parameters)) as Row | null) ?? null,
      run: (parameters: SqliteParameters = []) => statement.run(...toBunBindings(parameters)),
    };
  }

  close(): void {
    this.database.close();
  }
}

function toBunBindings(
  parameters: SqliteParameters,
): SqliteValue[] | [Record<string, SqliteValue>] {
  return Array.isArray(parameters) ? parameters : [parameters];
}

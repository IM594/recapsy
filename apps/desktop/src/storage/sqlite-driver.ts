export type SqliteValue = string | number | bigint | boolean | null | Uint8Array;
export type SqliteParameters = Record<string, SqliteValue> | SqliteValue[];
export type SqliteRow = Record<string, SqliteValue | undefined>;

export type SqliteRunResult = {
  changes: number;
  lastInsertRowid: number | bigint;
};

export type SqliteStatement<Row extends SqliteRow = SqliteRow> = {
  run(parameters?: SqliteParameters): SqliteRunResult;
  get(parameters?: SqliteParameters): Row | null;
  all(parameters?: SqliteParameters): Row[];
};

export type SqliteDatabase = {
  run(sql: string, parameters?: SqliteParameters): SqliteRunResult;
  prepare<Row extends SqliteRow = SqliteRow>(sql: string): SqliteStatement<Row>;
  close(): void;
};

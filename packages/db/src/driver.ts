/**
 * The SQLite driver abstraction.
 *
 * The app runs on op-sqlite inside React Native; the tests run on node:sqlite,
 * which ships with Node 22+. Both sit behind this interface, so every table,
 * migration and query in this package is exercised by the test suite against a
 * real SQLite engine - not a mock - and the same code then runs on the phone.
 */

export type SqlValue = string | number | null | Uint8Array;

export interface SqlRow {
  readonly [column: string]: SqlValue;
}

export interface SqlStatement {
  all<T extends SqlRow = SqlRow>(...params: SqlValue[]): T[];
  get<T extends SqlRow = SqlRow>(...params: SqlValue[]): T | undefined;
  run(...params: SqlValue[]): { changes: number; lastInsertRowId: number };
}

export interface SqliteDatabase {
  /** Execute one or more statements with no parameters and no result. */
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  /**
   * Run `fn` inside a transaction, committing on return and rolling back if it
   * throws. Nested calls join the outer transaction via SAVEPOINT.
   */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/**
 * Escape hatch used by the migration runner. Kept separate from the query API so
 * feature code cannot accidentally build SQL by string concatenation.
 */
export interface SqliteDriverFactory {
  open(path: string): SqliteDatabase;
}

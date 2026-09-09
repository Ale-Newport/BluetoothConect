/**
 * node:sqlite driver. Test and tooling use only - never bundled into the app.
 */
import { DatabaseSync } from 'node:sqlite';
import type { SqlRow, SqlStatement, SqlValue, SqliteDatabase } from './driver.js';

class NodeStatement implements SqlStatement {
  constructor(private readonly stmt: ReturnType<DatabaseSync['prepare']>) {}

  all<T extends SqlRow = SqlRow>(...params: SqlValue[]): T[] {
    return this.stmt.all(...(params as never[])) as unknown as T[];
  }

  get<T extends SqlRow = SqlRow>(...params: SqlValue[]): T | undefined {
    return this.stmt.get(...(params as never[])) as unknown as T | undefined;
  }

  run(...params: SqlValue[]): { changes: number; lastInsertRowId: number } {
    const result = this.stmt.run(...(params as never[]));
    return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
  }
}

export class NodeSqliteDatabase implements SqliteDatabase {
  private readonly db: DatabaseSync;
  private depth = 0;
  private savepointCounter = 0;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    // Foreign keys are OFF by default in SQLite, which silently defeats every
    // REFERENCES clause in the schema.
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA journal_mode = WAL');
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SqlStatement {
    return new NodeStatement(this.db.prepare(sql));
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      const name = `sp_${++this.savepointCounter}`;
      this.db.exec(`SAVEPOINT ${name}`);
      this.depth++;
      try {
        const result = fn();
        this.db.exec(`RELEASE ${name}`);
        return result;
      } catch (err) {
        this.db.exec(`ROLLBACK TO ${name}`);
        this.db.exec(`RELEASE ${name}`);
        throw err;
      } finally {
        this.depth--;
      }
    }
    this.db.exec('BEGIN');
    this.depth++;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.db.close();
  }
}

export function openNodeDatabase(path = ':memory:'): SqliteDatabase {
  return new NodeSqliteDatabase(path);
}

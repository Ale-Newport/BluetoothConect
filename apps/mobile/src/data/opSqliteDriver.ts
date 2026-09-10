import { open, type DB } from '@op-engineering/op-sqlite';
import type { SqlRow, SqlStatement, SqlValue, SqliteDatabase } from '@airlink/db';

/**
 * The op-sqlite driver.
 *
 * `@airlink/db` defines every table, migration and query against a small
 * `SqliteDatabase` interface. The tests run it on `node:sqlite`; the app runs it
 * here. Same schema, same repositories, same SQL - so the data layer is covered
 * by tests against a real engine rather than a mock, and what ships is what was
 * tested.
 *
 * op-sqlite's API is asynchronous by default but exposes synchronous variants,
 * and synchronous is what the interface needs: `HandshakeConfig.lookupTrustedKey`
 * is called from inside a state machine that cannot await. SQLite on a local
 * file is microseconds per statement, so the cost is nil and the alternative -
 * an async trust lookup - would be unusable where it matters most.
 */

/**
 * Normalise one value on the way out of SQLite.
 *
 * op-sqlite hands BLOB columns back as ArrayBuffer, while node:sqlite - which
 * the tests run against - hands back Uint8Array. Every repository would
 * otherwise have to tolerate both, and the one that forgot would fail only on
 * device: exactly how this was found, as "expected a BLOB column" on the very
 * first launch after onboarding.
 *
 * Normalising here, at the single boundary, means the repositories see one type
 * and the tests exercise the same code the app runs.
 */
function normaliseValue(value: unknown): SqlValue {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'bigint') {
    // SQLite integers can exceed the safe range; a row id or a timestamp that
    // does would be a corrupt read rather than something to silently truncate.
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error('sqlite: integer column exceeds the safe integer range');
    }
    return Number(value);
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new Error(`sqlite: unsupported column type ${typeof value}`);
}

function normaliseRow(row: Record<string, unknown>): SqlRow {
  const out: Record<string, SqlValue> = {};
  for (const key of Object.keys(row)) out[key] = normaliseValue(row[key]);
  return out;
}

/** And on the way IN: op-sqlite wants ArrayBuffer for a BLOB parameter. */
function toDriverParam(value: SqlValue): unknown {
  if (value instanceof Uint8Array) {
    // A subarray view must be copied, or op-sqlite writes the whole backing
    // buffer rather than the slice it was handed.
    return value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
      ? value.buffer
      : value.slice().buffer;
  }
  return value;
}

class OpStatement implements SqlStatement {
  constructor(
    private readonly db: DB,
    private readonly sql: string,
  ) {}

  all<T extends SqlRow = SqlRow>(...params: SqlValue[]): T[] {
    const result = this.db.executeSync(this.sql, params.map(toDriverParam) as never[]);
    return ((result.rows ?? []) as Record<string, unknown>[]).map(normaliseRow) as unknown as T[];
  }

  get<T extends SqlRow = SqlRow>(...params: SqlValue[]): T | undefined {
    return this.all<T>(...params)[0];
  }

  run(...params: SqlValue[]): { changes: number; lastInsertRowId: number } {
    const result = this.db.executeSync(this.sql, params.map(toDriverParam) as never[]);
    return {
      changes: result.rowsAffected ?? 0,
      lastInsertRowId: Number(result.insertId ?? 0),
    };
  }
}

class OpSqliteDatabase implements SqliteDatabase {
  private depth = 0;
  private savepointCounter = 0;

  constructor(private readonly db: DB) {}

  exec(sql: string): void {
    // A migration is several statements in one string; op-sqlite executes one
    // per call, so they are split on the semicolons that end a statement.
    for (const statement of splitStatements(sql)) {
      this.db.executeSync(statement);
    }
  }

  prepare(sql: string): SqlStatement {
    return new OpStatement(this.db, sql);
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      const name = `sp_${++this.savepointCounter}`;
      this.db.executeSync(`SAVEPOINT ${name}`);
      this.depth++;
      try {
        const result = fn();
        this.db.executeSync(`RELEASE ${name}`);
        return result;
      } catch (err) {
        this.db.executeSync(`ROLLBACK TO ${name}`);
        this.db.executeSync(`RELEASE ${name}`);
        throw err;
      } finally {
        this.depth--;
      }
    }
    this.db.executeSync('BEGIN');
    this.depth++;
    try {
      const result = fn();
      this.db.executeSync('COMMIT');
      return result;
    } catch (err) {
      this.db.executeSync('ROLLBACK');
      throw err;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Split a multi-statement SQL string on statement boundaries.
 *
 * Deliberately simple, and safe because it only ever sees the migration
 * constants in `@airlink/db` - never user input, never a peer's bytes. It skips
 * semicolons inside string literals and comments so a CHECK constraint
 * containing one cannot split a statement in half.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inString = false;
  let inLineComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i] as string;
    const next = sql[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      current += ch;
      continue;
    }
    if (!inString && ch === '-' && next === '-') {
      inLineComment = true;
      current += ch;
      continue;
    }
    if (ch === "'") {
      inString = !inString;
      current += ch;
      continue;
    }
    if (ch === ';' && !inString) {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export function openAppDatabase(name = 'airlink.db'): SqliteDatabase {
  const db = open({ name });
  db.executeSync('PRAGMA foreign_keys = ON');
  db.executeSync('PRAGMA journal_mode = WAL');
  // Durability without an fsync per write. WAL plus NORMAL is the standard
  // choice for a phone: a crash can lose the last transaction, a power cut
  // cannot corrupt the file.
  db.executeSync('PRAGMA synchronous = NORMAL');
  return new OpSqliteDatabase(db);
}

export { splitStatements as __splitStatementsForTests };

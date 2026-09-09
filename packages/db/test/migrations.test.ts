import { describe, expect, it } from 'vitest';
import { openNodeDatabase } from '../src/nodeDriver.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, migrate } from '../src/migrations.js';

describe('migrations', () => {
  it('brings a fresh database to the latest version', () => {
    const db = openNodeDatabase();
    const result = migrate(db);
    expect(result.from).toBe(0);
    expect(result.to).toBe(LATEST_SCHEMA_VERSION);
    expect(result.applied.length).toBe(MIGRATIONS.length);
    db.close();
  });

  it('is idempotent', () => {
    const db = openNodeDatabase();
    migrate(db);
    const second = migrate(db);
    expect(second.applied).toEqual([]);
    expect(second.to).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it('creates every table the app relies on', () => {
    const db = openNodeDatabase();
    migrate(db);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>()
      .map((r) => r.name);
    for (const expected of [
      'users', 'peers', 'devices', 'sessions', 'conversations', 'groups', 'group_members',
      'messages', 'reactions', 'files', 'transfers', 'game_sessions', 'game_events',
      'sync_sessions', 'trips', 'trip_members', 'trip_notes', 'settings', 'event_log',
    ]) {
      expect(names).toContain(expected);
    }
    db.close();
  });

  it('enforces foreign keys', () => {
    const db = openNodeDatabase();
    migrate(db);
    expect(() =>
      db.prepare('INSERT INTO devices (device_id, peer_id, last_seen_at) VALUES (?,?,?)').run('d1', 'nobody', 1),
    ).toThrow();
    db.close();
  });

  it('enforces CHECK constraints on enum-like columns', () => {
    const db = openNodeDatabase();
    migrate(db);
    expect(() =>
      db
        .prepare(
          'INSERT INTO peers (peer_id, display_name, identity_public, first_seen_at, last_seen_at, trust_state) VALUES (?,?,?,?,?,?)',
        )
        .run('p1', 'X', new Uint8Array(32), 1, 1, 'something-else'),
    ).toThrow();
    db.close();
  });

  it('rolls a failed transaction back completely', () => {
    const db = openNodeDatabase();
    migrate(db);
    expect(() =>
      db.transaction(() => {
        db.prepare(
          'INSERT INTO peers (peer_id, display_name, identity_public, first_seen_at, last_seen_at, trust_state) VALUES (?,?,?,?,?,?)',
        ).run('p1', 'X', new Uint8Array(32), 1, 1, 'trusted');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.prepare('SELECT COUNT(*) AS n FROM peers').get<{ n: number }>()?.n).toBe(0);
    db.close();
  });

  it('supports nested transactions via savepoints', () => {
    const db = openNodeDatabase();
    migrate(db);
    db.transaction(() => {
      db.prepare(
        'INSERT INTO peers (peer_id, display_name, identity_public, first_seen_at, last_seen_at, trust_state) VALUES (?,?,?,?,?,?)',
      ).run('outer', 'O', new Uint8Array(32), 1, 1, 'trusted');
      try {
        db.transaction(() => {
          db.prepare(
            'INSERT INTO peers (peer_id, display_name, identity_public, first_seen_at, last_seen_at, trust_state) VALUES (?,?,?,?,?,?)',
          ).run('inner', 'I', new Uint8Array(32), 1, 1, 'trusted');
          throw new Error('inner failure');
        });
      } catch {
        // The inner savepoint rolls back; the outer insert survives.
      }
    });
    const rows = db.prepare('SELECT peer_id FROM peers ORDER BY peer_id').all<{ peer_id: string }>();
    expect(rows.map((r) => r.peer_id)).toEqual(['outer']);
    db.close();
  });
});

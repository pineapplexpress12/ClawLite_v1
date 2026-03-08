import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/schema.js';

describe('schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  it('should run all migrations without error', () => {
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('should create all expected tables', () => {
    runMigrations(db);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all() as { name: string }[];

    const tableNames = tables.map((t) => t.name).sort();

    expect(tableNames).toContain('jobs');
    expect(tableNames).toContain('nodes');
    expect(tableNames).toContain('runs');
    expect(tableNames).toContain('ledger');
    expect(tableNames).toContain('memory');
    expect(tableNames).toContain('daily_budget');
    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('sub_agents');
    expect(tableNames).toContain('approvals');
    expect(tableNames).toContain('pending_revisions');
    expect(tableNames).toContain('pending_approval_choices');
    expect(tableNames).toContain('artifacts');
  });

  it('should create the memory_fts virtual table', () => {
    runMigrations(db);

    const fts = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'"
    ).get() as { name: string } | undefined;

    expect(fts).toBeDefined();
  });

  it('should seed daily_budget with a single row', () => {
    runMigrations(db);

    const row = db.prepare('SELECT * FROM daily_budget WHERE id = 1').get() as {
      id: number;
      tokens_consumed: number;
    } | undefined;

    expect(row).toBeDefined();
    expect(row!.id).toBe(1);
    expect(row!.tokens_consumed).toBe(0);
  });

  it('should be idempotent (run migrations twice)', () => {
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });
});

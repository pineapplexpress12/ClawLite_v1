import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

let db: Database.Database | null = null;

export function getClawliteHome(): string {
  return path.join(process.cwd(), '.clawlite');
}

export function getDbPath(): string {
  return path.join(getClawliteHome(), 'clawlite.db');
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function initDb(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? getDbPath();

  // Ensure parent directory exists
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(resolvedPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Reasonable busy timeout for concurrent access
  db.pragma('busy_timeout = 5000');

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

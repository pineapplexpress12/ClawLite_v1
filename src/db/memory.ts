import { v4 as uuid } from 'uuid';
import { getDb } from './connection.js';

export interface MemoryRow {
  id: string;
  type: string;
  content: string;
  tags: string;
  token_count: number;
  created_at: number;
  expires_at: number | null;
}

export interface InsertMemoryParams {
  type: string;
  content: string;
  tags: string[];
  tokenCount: number;
  expiresAt?: number | null;
}

export function insertMemory(params: InsertMemoryParams): string {
  const db = getDb();
  const id = uuid();
  const now = Date.now();

  db.prepare(`
    INSERT INTO memory (id, type, content, tags, token_count, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.type,
    params.content,
    JSON.stringify(params.tags),
    params.tokenCount,
    now,
    params.expiresAt ?? null,
  );

  return id;
}

export function getMemory(id: string): MemoryRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM memory WHERE id = ?').get(id) as MemoryRow | undefined;
}

export function getRecentMemories(limit: number): MemoryRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM memory ORDER BY created_at DESC LIMIT ?')
    .all(limit) as MemoryRow[];
}

export function searchMemoryByTags(tags: string[], limit: number): MemoryRow[] {
  const db = getDb();
  // Match any of the given tags using JSON
  const conditions = tags.map(() => "tags LIKE ?").join(' OR ');
  const values = tags.map(t => `%"${t}"%`);
  return db.prepare(`SELECT * FROM memory WHERE ${conditions} ORDER BY created_at DESC LIMIT ?`)
    .all(...values, limit) as MemoryRow[];
}

export interface FtsResult extends MemoryRow {
  rank: number;
}

export function searchMemoryFts(query: string, limit: number): FtsResult[] {
  const db = getDb();
  return db.prepare(`
    SELECT m.*, fts.rank
    FROM memory_fts fts
    JOIN memory m ON m.rowid = fts.rowid
    WHERE memory_fts MATCH ?
    ORDER BY fts.rank
    LIMIT ?
  `).all(query, limit) as FtsResult[];
}

export function deleteExpiredMemories(now: number): number {
  const db = getDb();
  const result = db.prepare('DELETE FROM memory WHERE expires_at IS NOT NULL AND expires_at < ?')
    .run(now);
  return result.changes;
}

export function countMemories(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as cnt FROM memory').get() as { cnt: number };
  return row.cnt;
}

export function countMemoriesByType(): Record<string, number> {
  const db = getDb();
  const rows = db.prepare('SELECT type, COUNT(*) as cnt FROM memory GROUP BY type')
    .all() as { type: string; cnt: number }[];
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.type] = row.cnt;
  }
  return result;
}

export function deleteOldestMemories(type: string, count: number): number {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM memory WHERE id IN (
      SELECT id FROM memory WHERE type = ? ORDER BY created_at ASC LIMIT ?
    )
  `).run(type, count);
  return result.changes;
}

export function deleteMemory(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM memory WHERE id = ?').run(id);
}

import { getDb } from './connection.js';

export interface SessionRow {
  id: number;
  chat_id: string;
  channel: string;
  role: string;
  content: string;
  token_count: number;
  created_at: number;
}

export interface InsertSessionParams {
  chatId: string;
  channel: string;
  role: string;
  content: string;
  tokenCount: number;
}

export function insertSession(params: InsertSessionParams): number {
  const db = getDb();
  const now = Date.now();

  const result = db.prepare(`
    INSERT INTO sessions (chat_id, channel, role, content, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(params.chatId, params.channel, params.role, params.content, params.tokenCount, now);

  return Number(result.lastInsertRowid);
}

export function getRecentSessions(chatId: string, channel: string, limit: number): SessionRow[] {
  const db = getDb();
  // Get in chronological order (oldest first) for message history
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT * FROM sessions
      WHERE chat_id = ? AND channel = ?
      ORDER BY created_at DESC
      LIMIT ?
    ) sub ORDER BY created_at ASC
  `).all(chatId, channel, limit) as SessionRow[];
  return rows;
}

export function getAllSessionTurns(chatId: string, channel: string): SessionRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM sessions WHERE chat_id = ? AND channel = ? ORDER BY created_at ASC
  `).all(chatId, channel) as SessionRow[];
}

export function getTotalSessionTokens(chatId: string, channel: string): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(SUM(token_count), 0) as total FROM sessions WHERE chat_id = ? AND channel = ?
  `).get(chatId, channel) as { total: number };
  return row.total;
}

export function deleteSessionTurns(chatId: string, channel: string, ids: number[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM sessions WHERE chat_id = ? AND channel = ? AND id IN (${placeholders})`)
    .run(chatId, channel, ...ids);
}

export function clearSessions(chatId?: string, channel?: string): void {
  const db = getDb();
  if (chatId && channel) {
    db.prepare('DELETE FROM sessions WHERE chat_id = ? AND channel = ?').run(chatId, channel);
  } else {
    db.prepare('DELETE FROM sessions').run();
  }
}

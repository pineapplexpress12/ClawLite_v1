import { insertSession, getRecentSessions, getTotalSessionTokens, type SessionRow } from '../db/sessions.js';
import { getConfig } from '../core/config.js';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface SessionTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Store a user or assistant turn in the session.
 */
export function storeTurn(chatId: string, channel: string, role: 'user' | 'assistant', content: string): void {
  const tokenCount = estimateTokens(content);
  insertSession({ chatId, channel, role, content, tokenCount });
}

/**
 * Retrieve recent session turns for injection into LLM prompt.
 * Returns the last N turns (from config.session.turnsInjectedIntoChat).
 */
export function getSessionContext(chatId: string, channel: string): SessionTurn[] {
  const config = getConfig();
  const limit = config.session.turnsInjectedIntoChat;
  const rows = getRecentSessions(chatId, channel, limit);

  return rows.map(r => ({
    role: r.role as 'user' | 'assistant',
    content: r.content,
  }));
}

/**
 * Check if session needs compaction.
 */
export function needsCompaction(chatId: string, channel: string): boolean {
  const config = getConfig();
  const totalTokens = getTotalSessionTokens(chatId, channel);
  return totalTokens > config.session.compactionThresholdTokens;
}

/**
 * Get all turns for compaction processing.
 */
export function getSessionTokenCount(chatId: string, channel: string): number {
  return getTotalSessionTokens(chatId, channel);
}

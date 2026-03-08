import { getAllSessionTurns, deleteSessionTurns } from '../db/sessions.js';
import { getConfig } from '../core/config.js';
import { complete } from '../llm/provider.js';
import { ingestMemory } from '../memory/store.js';
import { logger } from '../core/logger.js';

/**
 * Compact a session by summarizing old turns and storing as episodic memory.
 * Keeps the most recent turnsInjectedIntoChat turns intact.
 */
export async function compactSession(chatId: string, channel: string): Promise<void> {
  const config = getConfig();
  const allTurns = getAllSessionTurns(chatId, channel);
  const totalTokens = allTurns.reduce((sum, t) => sum + t.token_count, 0);

  if (totalTokens <= config.session.compactionThresholdTokens) {
    return;
  }

  // Keep the most recent turns
  const keepCount = config.session.turnsInjectedIntoChat;
  const toCompact = allTurns.slice(0, -keepCount);

  if (toCompact.length === 0) return;

  // Summarize using fast tier
  const summary = await complete({
    model: 'fast',
    messages: [
      {
        role: 'system',
        content: 'Summarize this conversation in 2-3 sentences. Focus on key facts, decisions, and context that would be useful for continuing the conversation later.',
      },
      {
        role: 'user',
        content: toCompact.map(t => `${t.role}: ${t.content}`).join('\n'),
      },
    ],
  });

  // Store as episodic memory
  await ingestMemory({
    type: 'episodic',
    content: summary.text,
    tags: ['session_compaction', chatId],
    ttlDays: 30,
  });

  // Delete compacted turns
  deleteSessionTurns(chatId, channel, toCompact.map(t => t.id));

  logger.info('Session compacted', {
    chatId,
    channel,
    compactedTurns: toCompact.length,
    tokensRecovered: toCompact.reduce((sum, t) => sum + t.token_count, 0),
  });
}

import { deleteExpiredMemories, countMemories, deleteOldestMemories } from '../db/memory.js';
import { logger } from '../core/logger.js';

const MAX_MEMORY_ITEMS = 500;

/**
 * Run daily memory pruning:
 * 1. Delete expired episodic memories
 * 2. Enforce hard cap (max 500 items)
 */
export function pruneMemory(): { before: number; after: number; expired: number } {
  const before = countMemories();

  // 1. Delete expired memories
  const expired = deleteExpiredMemories(Date.now());

  // 2. Enforce hard cap
  const afterExpiry = countMemories();
  if (afterExpiry > MAX_MEMORY_ITEMS) {
    const excess = afterExpiry - MAX_MEMORY_ITEMS;
    deleteOldestMemories('episodic', excess);
  }

  const after = countMemories();

  if (before !== after) {
    logger.info('Memory pruned', { before, after, expired });
  }

  return { before, after, expired };
}

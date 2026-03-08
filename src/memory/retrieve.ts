import { searchMemoryByTags, searchMemoryFts, type MemoryRow } from '../db/memory.js';

const MAX_ITEMS = 3;
const MAX_TOKENS = 500;

export interface RetrievedMemory {
  id: string;
  type: string;
  content: string;
  tags: string[];
  tokenCount: number;
}

/**
 * Retrieve relevant memories: tag match first, FTS5 second.
 * Returns max 3 items, max 500 tokens total.
 */
export function retrieveMemories(
  query: string,
  tags: string[] = [],
  maxItems: number = MAX_ITEMS,
  maxTokens: number = MAX_TOKENS,
): RetrievedMemory[] {
  const results: MemoryRow[] = [];
  const seenIds = new Set<string>();

  // 1. Tag match first
  if (tags.length > 0) {
    const tagResults = searchMemoryByTags(tags, maxItems);
    for (const row of tagResults) {
      if (!seenIds.has(row.id)) {
        results.push(row);
        seenIds.add(row.id);
      }
    }
  }

  // 2. FTS5 search if we need more items
  if (results.length < maxItems && query.trim()) {
    try {
      const ftsResults = searchMemoryFts(query, maxItems);
      for (const row of ftsResults) {
        if (!seenIds.has(row.id)) {
          results.push(row);
          seenIds.add(row.id);
        }
        if (results.length >= maxItems) break;
      }
    } catch {
      // FTS5 may fail on certain queries — return tag results only
    }
  }

  // 3. Enforce token budget
  const selected: RetrievedMemory[] = [];
  let totalTokens = 0;

  for (const row of results) {
    if (totalTokens + row.token_count > maxTokens) {
      if (selected.length === 0) {
        // Always include at least one item even if it exceeds budget
        selected.push(toRetrievedMemory(row));
      }
      break;
    }
    selected.push(toRetrievedMemory(row));
    totalTokens += row.token_count;
  }

  return selected;
}

function toRetrievedMemory(row: MemoryRow): RetrievedMemory {
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    tags: JSON.parse(row.tags) as string[],
    tokenCount: row.token_count,
  };
}

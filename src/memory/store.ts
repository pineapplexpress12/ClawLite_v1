import { insertMemory, searchMemoryFts } from '../db/memory.js';

/**
 * Rough token estimator (~4 chars per token).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const DEFAULT_TTL_DAYS: Record<string, number | null> = {
  episodic: 30,
  semantic: null,
  procedural: null,
};

export interface IngestMemoryParams {
  type: 'episodic' | 'semantic' | 'procedural';
  content: string;
  tags: string[];
  ttlDays?: number | null;
}

export interface IngestResult {
  stored: boolean;
  memoryId?: string;
  reason?: string;
}

/**
 * Ingest a memory with size gate and duplicate gate.
 */
export async function ingestMemory(params: IngestMemoryParams): Promise<IngestResult> {
  // 1. Size gate: reject if content > 300 tokens
  const tokens = estimateTokens(params.content);
  if (tokens > 300) {
    return { stored: false, reason: 'content_too_long' };
  }

  // 2. Duplicate gate: check FTS5 for similar existing memory
  try {
    const similar = searchMemoryFts(params.content, 1);
    if (similar.length > 0 && Math.abs(similar[0]!.rank) < 1) {
      // Low rank magnitude = high relevance in FTS5 (rank is negative, closer to 0 = better match)
      return { stored: false, reason: 'duplicate_detected' };
    }
  } catch {
    // FTS5 search may fail on certain queries — proceed with storage
  }

  // 3. Calculate TTL
  const ttlDays = params.ttlDays ?? DEFAULT_TTL_DAYS[params.type] ?? null;
  const expiresAt = ttlDays != null ? Date.now() + (ttlDays * 24 * 60 * 60 * 1000) : null;

  // 4. Store
  const id = insertMemory({
    type: params.type,
    content: params.content,
    tags: params.tags,
    tokenCount: tokens,
    expiresAt,
  });

  return { stored: true, memoryId: id };
}

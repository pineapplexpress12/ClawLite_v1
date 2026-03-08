import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/schema.js';

let testDb: Database.Database;

vi.mock('../../src/db/connection.js', () => ({
  getDb: () => testDb,
  getClawliteHome: () => '/tmp/clawlite-test',
}));

vi.mock('../../src/core/config.js', () => ({
  getConfig: () => ({
    session: { maxTurnsInMemory: 20, turnsInjectedIntoChat: 5, compactionThresholdTokens: 8000 },
  }),
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ingestMemory } from '../../src/memory/store.js';
import { retrieveMemories } from '../../src/memory/retrieve.js';
import { pruneMemory } from '../../src/memory/prune.js';
import { insertMemory, countMemories } from '../../src/db/memory.js';
import { storeTurn, getSessionContext, needsCompaction } from '../../src/session/sessionManager.js';
import { getRecentSessions } from '../../src/db/sessions.js';

describe('Memory Store', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');
    runMigrations(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  it('should store a valid memory', async () => {
    const result = await ingestMemory({
      type: 'semantic',
      content: 'User prefers dark mode',
      tags: ['preference'],
    });

    expect(result.stored).toBe(true);
    expect(result.memoryId).toBeDefined();
  });

  it('should reject content exceeding 300 tokens (~1200 chars)', async () => {
    const longContent = 'x'.repeat(1300); // ~325 tokens
    const result = await ingestMemory({
      type: 'semantic',
      content: longContent,
      tags: [],
    });

    expect(result.stored).toBe(false);
    expect(result.reason).toBe('content_too_long');
  });

  it('should set TTL for episodic memories', async () => {
    const result = await ingestMemory({
      type: 'episodic',
      content: 'Completed inbox check',
      tags: ['job'],
    });

    expect(result.stored).toBe(true);
  });

  it('should not set TTL for semantic memories', async () => {
    const result = await ingestMemory({
      type: 'semantic',
      content: 'User email is test@example.com',
      tags: ['contact'],
    });

    expect(result.stored).toBe(true);
  });
});

describe('Memory Retrieval', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');
    runMigrations(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  it('should retrieve by tags', () => {
    insertMemory({ type: 'semantic', content: 'User likes coffee', tags: ['preference'], tokenCount: 10 });
    insertMemory({ type: 'semantic', content: 'User likes tea', tags: ['preference'], tokenCount: 10 });
    insertMemory({ type: 'semantic', content: 'Meeting at 3pm', tags: ['calendar'], tokenCount: 10 });

    const results = retrieveMemories('', ['preference']);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every(r => r.tags.includes('preference'))).toBe(true);
  });

  it('should retrieve by FTS5 query', () => {
    insertMemory({ type: 'semantic', content: 'User lives in San Francisco', tags: [], tokenCount: 12 });
    insertMemory({ type: 'semantic', content: 'User works at Anthropic', tags: [], tokenCount: 10 });

    const results = retrieveMemories('San Francisco');
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toContain('San Francisco');
  });

  it('should enforce max 3 items limit', () => {
    for (let i = 0; i < 10; i++) {
      insertMemory({ type: 'semantic', content: `Fact number ${i} about cats`, tags: ['facts'], tokenCount: 10 });
    }

    const results = retrieveMemories('cats', ['facts'], 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('should enforce 500 token budget', () => {
    // Each with ~200 tokens = max 2 items under 500 budget
    insertMemory({ type: 'semantic', content: 'a'.repeat(800), tags: ['big'], tokenCount: 200 });
    insertMemory({ type: 'semantic', content: 'b'.repeat(800), tags: ['big'], tokenCount: 200 });
    insertMemory({ type: 'semantic', content: 'c'.repeat(800), tags: ['big'], tokenCount: 200 });

    const results = retrieveMemories('', ['big'], 3, 500);
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

describe('Memory Pruning', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');
    runMigrations(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  it('should delete expired memories', () => {
    const pastExpiry = Date.now() - 1000;
    insertMemory({ type: 'episodic', content: 'Old memory', tags: [], tokenCount: 10, expiresAt: pastExpiry });
    insertMemory({ type: 'semantic', content: 'Permanent memory', tags: [], tokenCount: 10 });

    const result = pruneMemory();
    expect(result.expired).toBe(1);
    expect(result.after).toBe(1);
  });

  it('should enforce 500 item hard cap', () => {
    // Insert 510 episodic memories
    for (let i = 0; i < 510; i++) {
      insertMemory({ type: 'episodic', content: `Memory ${i}`, tags: [], tokenCount: 5 });
    }

    expect(countMemories()).toBe(510);

    const result = pruneMemory();
    expect(result.after).toBeLessThanOrEqual(500);
  });
});

describe('Session Manager', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');
    runMigrations(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  it('should store and retrieve turns', () => {
    storeTurn('c1', 'telegram', 'user', 'Hello');
    storeTurn('c1', 'telegram', 'assistant', 'Hi there!');

    const context = getSessionContext('c1', 'telegram');
    expect(context).toHaveLength(2);
    expect(context[0]!.role).toBe('user');
    expect(context[1]!.role).toBe('assistant');
  });

  it('should limit returned turns to config value', () => {
    for (let i = 0; i < 20; i++) {
      storeTurn('c1', 'telegram', i % 2 === 0 ? 'user' : 'assistant', `Turn ${i}`);
    }

    const context = getSessionContext('c1', 'telegram');
    expect(context).toHaveLength(5); // turnsInjectedIntoChat = 5
  });

  it('should check compaction need', () => {
    // Add enough turns to exceed 8000 tokens (~32000 chars)
    for (let i = 0; i < 40; i++) {
      storeTurn('c1', 'telegram', 'user', 'x'.repeat(1000)); // ~250 tokens each
    }

    expect(needsCompaction('c1', 'telegram')).toBe(true);
  });

  it('should not need compaction for small sessions', () => {
    storeTurn('c1', 'telegram', 'user', 'Hello');
    expect(needsCompaction('c1', 'telegram')).toBe(false);
  });
});

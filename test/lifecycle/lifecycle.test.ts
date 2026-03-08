import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/schema.js';

let testDb: Database.Database;

vi.mock('../../src/db/connection.js', () => ({
  getDb: () => testDb,
  getClawliteHome: () => '/tmp/clawlite-test',
  closeDb: () => {},
}));

vi.mock('../../src/core/config.js', () => ({
  getConfig: () => ({
    operator: { name: 'TestBot' },
    llm: { provider: 'openrouter', tiers: { fast: 'gpt-4o-mini', balanced: 'gpt-4o', strong: 'claude-opus' } },
    budgets: { dailyTokens: 200000, perJobTokens: 50000, maxToolCallsPerJob: 200 },
    hardLimits: { maxNodesPerJob: 20, maxTotalLLMCalls: 30, maxJobDurationMs: 300000, maxRetriesTotalPerJob: 10 },
    channels: {},
  }),
}));

vi.mock('../../src/llm/provider.js', () => ({
  complete: async () => ({ text: 'ok', parsed: null, usage: { total_tokens: 10 } }),
}));

vi.mock('../../src/heartbeat/scheduler.js', () => ({
  stopHeartbeat: () => {},
  startHeartbeat: () => {},
  isHeartbeatRunning: () => false,
}));

vi.mock('../../src/channels/registry.js', () => ({
  stopAllChannels: async () => {},
  startAllChannels: async () => {},
  getEnabledChannels: () => [],
}));

vi.mock('../../src/http/server.js', () => ({
  stopHTTPServer: async () => {},
  startHTTPServer: async () => {},
}));

import { createJob } from '../../src/db/jobs.js';
import { createNode, transitionNodeStatus, getNode } from '../../src/db/nodes.js';
import { recoverCrashedJobs, EXIT_CODES } from '../../src/lifecycle.js';
import { graphEvents } from '../../src/core/events.js';

describe('Phase 13: Crash Recovery + Polish', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');
    runMigrations(testDb);
  });

  afterEach(async () => {
    graphEvents.removeAllListeners();
    await new Promise(resolve => setTimeout(resolve, 50));
    testDb.close();
  });

  describe('crash recovery', () => {
    it('should reset running nodes to pending on recovery', () => {
      const job = createJob({ goal: 'Crashed job', triggerType: 'channel_message', channel: 'telegram', chatId: 'u1' });
      const node = createNode({ jobId: job.id, type: 'test', assignedAgent: 'W', model: 'fast' });
      transitionNodeStatus(node.id, 'running');

      // Verify it's running
      expect(getNode(node.id)!.status).toBe('running');

      // Recover
      recoverCrashedJobs();

      // Should be reset to pending
      const recovered = getNode(node.id)!;
      expect(recovered.status).toBe('pending');
    });

    it('should not affect completed nodes', () => {
      const job = createJob({ goal: 'Partial job', triggerType: 'channel_message', channel: 'telegram', chatId: 'u1' });
      const node1 = createNode({ jobId: job.id, type: 'step1', assignedAgent: 'W', model: 'fast' });
      const node2 = createNode({ jobId: job.id, type: 'step2', assignedAgent: 'W', model: 'fast' });
      transitionNodeStatus(node1.id, 'running');
      transitionNodeStatus(node1.id, 'completed');
      transitionNodeStatus(node2.id, 'running');

      recoverCrashedJobs();

      expect(getNode(node1.id)!.status).toBe('completed');
      expect(getNode(node2.id)!.status).toBe('pending');
    });
  });

  describe('exit codes', () => {
    it('should define standard exit codes', () => {
      expect(EXIT_CODES.CLEAN).toBe(0);
      expect(EXIT_CODES.STARTUP_FAILURE).toBe(1);
      expect(EXIT_CODES.CONFIG_ERROR).toBe(2);
      expect(EXIT_CODES.DATABASE_ERROR).toBe(3);
      expect(EXIT_CODES.UNHANDLED_EXCEPTION).toBe(4);
      expect(EXIT_CODES.SIGNAL).toBe(5);
    });
  });

  describe('entry point', () => {
    it('should export startClawLite function', async () => {
      const { startClawLite } = await import('../../src/index.js');
      expect(typeof startClawLite).toBe('function');
    });
  });

  describe('WebChat SPA', () => {
    it('should have static HTML file', async () => {
      const { existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      const spaPath = join(process.cwd(), 'src/channels/webchat/static/index.html');
      expect(existsSync(spaPath)).toBe(true);
    });
  });
});

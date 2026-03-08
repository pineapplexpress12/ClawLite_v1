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
    operator: { name: 'TestBot' },
    llm: { provider: 'openrouter', tiers: { fast: 'gpt-4o-mini', balanced: 'gpt-4o', strong: 'claude-opus' } },
    budgets: { dailyTokens: 200000, perJobTokens: 50000, maxToolCallsPerJob: 200 },
    hardLimits: { maxNodesPerJob: 20, maxTotalLLMCalls: 30, maxJobDurationMs: 300000, maxRetriesTotalPerJob: 10, agenticMaxIterations: 5, agenticMaxNodes: 10, agenticMaxTokenBudget: 30000 },
    session: { turnsInjectedIntoChat: 5, maxTurnsInMemory: 20, compactionThresholdTokens: 8000 },
    heartbeat: { enabled: true, intervalMinutes: 30, model: 'fast' },
    channels: {},
  }),
}));

let mockLLMResponse: any = { text: '{"action":"none"}', parsed: { action: 'none' }, usage: { total_tokens: 100 } };

vi.mock('../../src/llm/provider.js', () => ({
  complete: async () => mockLLMResponse,
}));

import { startHeartbeat, stopHeartbeat, isHeartbeatRunning } from '../../src/heartbeat/scheduler.js';
import { runHeartbeatCheck } from '../../src/heartbeat/checker.js';
import { graphEvents } from '../../src/core/events.js';

// Mock HEARTBEAT.md
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    existsSync: (path: string) => {
      if (path.includes('HEARTBEAT.md')) return mockHeartbeatExists;
      return actual.existsSync(path);
    },
    readFileSync: (path: string, encoding?: string) => {
      if (typeof path === 'string' && path.includes('HEARTBEAT.md')) return mockHeartbeatContent;
      return actual.readFileSync(path, encoding);
    },
  };
});

let mockHeartbeatExists = true;
let mockHeartbeatContent = '# Heartbeat Checks\n- Check for overdue invoices\n- Alert if no emails received today';

describe('Phase 10: Heartbeat + Cron', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');
    runMigrations(testDb);
    mockHeartbeatExists = true;
    mockHeartbeatContent = '# Heartbeat Checks\n- Check for overdue invoices';
    mockLLMResponse = { text: '{"action":"none"}', parsed: { action: 'none' }, usage: { total_tokens: 100 } };
  });

  afterEach(async () => {
    stopHeartbeat();
    graphEvents.removeAllListeners();
    await new Promise(resolve => setTimeout(resolve, 50));
    testDb.close();
  });

  // === SCHEDULER ===
  describe('scheduler', () => {
    it('should start and stop the heartbeat', () => {
      expect(isHeartbeatRunning()).toBe(false);
      startHeartbeat(30);
      expect(isHeartbeatRunning()).toBe(true);
      stopHeartbeat();
      expect(isHeartbeatRunning()).toBe(false);
    });

    it('should not start twice', () => {
      startHeartbeat(30);
      startHeartbeat(30); // should warn, not create duplicate
      expect(isHeartbeatRunning()).toBe(true);
      stopHeartbeat();
      expect(isHeartbeatRunning()).toBe(false);
    });
  });

  // === CHECKER ===
  describe('checker', () => {
    it('should return none when no action needed', async () => {
      const result = await runHeartbeatCheck();
      expect(result.action).toBe('none');
    });

    it('should skip when no checklist exists', async () => {
      mockHeartbeatExists = false;
      const result = await runHeartbeatCheck();
      expect(result.action).toBe('none');
      expect(result.reason).toBe('no_checklist');
    });

    it('should skip when budget exhausted', async () => {
      // Set budget to nearly exhausted
      testDb.prepare('UPDATE daily_budget SET tokens_consumed = 200000 WHERE id = 1').run();
      const result = await runHeartbeatCheck();
      expect(result.action).toBe('none');
      expect(result.reason).toBe('budget_exhausted');
    });

    it('should trigger a job when LLM says to', async () => {
      mockLLMResponse = {
        text: '{"action":"trigger","templateId":"inbox_assistant","slots":{"query":"unread"},"reason":"Morning inbox check"}',
        parsed: {
          action: 'trigger',
          templateId: 'inbox_assistant',
          slots: { query: 'unread' },
          reason: 'Morning inbox check',
        },
        usage: { total_tokens: 150 },
      };

      const result = await runHeartbeatCheck();
      expect(result.action).toBe('trigger');
      expect(result.templateId).toBe('inbox_assistant');
      expect(result.reason).toBe('Morning inbox check');
    });

    it('should handle unknown template gracefully', async () => {
      mockLLMResponse = {
        text: '{"action":"trigger","templateId":"nonexistent_template","reason":"test"}',
        parsed: {
          action: 'trigger',
          templateId: 'nonexistent_template',
          reason: 'test',
        },
        usage: { total_tokens: 100 },
      };

      const result = await runHeartbeatCheck();
      expect(result.action).toBe('none');
      expect(result.reason).toContain('template_not_found');
    });

    it('should record token usage', async () => {
      mockLLMResponse = {
        text: '{"action":"none"}',
        parsed: { action: 'none' },
        usage: { total_tokens: 200 },
      };

      await runHeartbeatCheck();
      const budget = testDb.prepare('SELECT tokens_consumed FROM daily_budget WHERE id = 1').get() as any;
      expect(budget.tokens_consumed).toBe(200);
    });
  });
});

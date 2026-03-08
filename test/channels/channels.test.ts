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
    llm: { provider: 'openrouter', tiers: { fast: 'gpt-4o-mini', balanced: 'gpt-4o', strong: 'claude-opus' } },
    budgets: { dailyTokens: 200000, perJobTokens: 50000, maxToolCallsPerJob: 200 },
    hardLimits: { maxNodesPerJob: 20, maxTotalLLMCalls: 30, maxJobDurationMs: 300000, maxRetriesTotalPerJob: 10, agenticMaxIterations: 5, agenticMaxNodes: 10, agenticMaxTokenBudget: 30000 },
    session: { turnsInjectedIntoChat: 5, maxTurnsInMemory: 20, compactionThresholdTokens: 8000 },
    channels: {
      telegram: { enabled: true, allowedUserIds: ['123', '456'] },
      webchat: { enabled: true },
      discord: { enabled: false },
    },
  }),
}));

import { registerChannel, getChannel, getEnabledChannels, clearChannels } from '../../src/channels/registry.js';
import { isAuthorized } from '../../src/channels/shared/auth.js';
import { sendWithRetry } from '../../src/channels/shared/retry.js';
import { recoverChannelState } from '../../src/channels/shared/recovery.js';
import type { ChannelAdapter, InboundMessage, OutboundMessage } from '../../src/channels/types.js';
import { createJob } from '../../src/db/jobs.js';
import { createNode, transitionNodeStatus, getNode } from '../../src/db/nodes.js';

// Mock adapter for testing
function createMockAdapter(name: string): ChannelAdapter & { sentMessages: { chatId: string; message: OutboundMessage }[] } {
  const adapter = {
    name,
    sentMessages: [] as { chatId: string; message: OutboundMessage }[],
    started: false,
    stopped: false,
    messageHandlers: [] as ((msg: InboundMessage) => Promise<void>)[],

    async start() { adapter.started = true; },
    async stop() { adapter.stopped = true; },
    async sendMessage(chatId: string, message: OutboundMessage) {
      adapter.sentMessages.push({ chatId, message });
    },
    onMessage(handler: (msg: InboundMessage) => Promise<void>) {
      adapter.messageHandlers.push(handler);
    },
  };
  return adapter;
}

describe('Phase 8: Channel Adapters', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');
    runMigrations(testDb);
    clearChannels();
  });

  afterEach(() => {
    testDb.close();
  });

  // === REGISTRY ===
  describe('registry', () => {
    it('should register and retrieve a channel', () => {
      const adapter = createMockAdapter('test');
      registerChannel(adapter);
      expect(getChannel('test')).toBe(adapter);
    });

    it('should list enabled channels', () => {
      registerChannel(createMockAdapter('telegram'));
      registerChannel(createMockAdapter('webchat'));
      expect(getEnabledChannels()).toHaveLength(2);
    });
  });

  // === AUTH ===
  describe('auth', () => {
    it('should authorize allowed users', () => {
      expect(isAuthorized('telegram', '123')).toBe(true);
      expect(isAuthorized('telegram', '456')).toBe(true);
    });

    it('should reject unauthorized users', () => {
      expect(isAuthorized('telegram', '999')).toBe(false);
    });

    it('should reject disabled channels', () => {
      expect(isAuthorized('discord', '123')).toBe(false);
    });

    it('should allow all users for webchat (no allowlist)', () => {
      expect(isAuthorized('webchat', 'anyone')).toBe(true);
    });
  });

  // === RETRY ===
  describe('sendWithRetry', () => {
    it('should succeed on first try', async () => {
      let calls = 0;
      await sendWithRetry(async () => { calls++; }, 3, 10);
      expect(calls).toBe(1);
    });

    it('should retry on failure and succeed', async () => {
      let calls = 0;
      await sendWithRetry(async () => {
        calls++;
        if (calls < 3) throw new Error('fail');
      }, 3, 10);
      expect(calls).toBe(3);
    });

    it('should throw after all retries exhausted', async () => {
      await expect(
        sendWithRetry(async () => { throw new Error('always fails'); }, 2, 10),
      ).rejects.toThrow('always fails');
    });
  });

  // === RECOVERY ===
  describe('recovery', () => {
    it('should reset running nodes to pending', () => {
      const job = createJob({ goal: 'Test', triggerType: 'channel_message', channel: 'telegram', chatId: 'u1' });
      const node = createNode({ jobId: job.id, type: 'test', assignedAgent: 'W', model: 'fast' });
      transitionNodeStatus(node.id, 'running');

      recoverChannelState();

      const updated = getNode(node.id);
      expect(updated.status).toBe('pending');
    });
  });

  // === MOCK ADAPTER ===
  describe('mock adapter', () => {
    it('should send messages', async () => {
      const adapter = createMockAdapter('test');
      await adapter.sendMessage('chat1', { text: 'Hello!' });
      expect(adapter.sentMessages).toHaveLength(1);
      expect(adapter.sentMessages[0]!.message.text).toBe('Hello!');
    });

    it('should register message handlers', () => {
      const adapter = createMockAdapter('test');
      const handler = async () => {};
      adapter.onMessage(handler);
      expect(adapter.messageHandlers).toHaveLength(1);
    });
  });
});

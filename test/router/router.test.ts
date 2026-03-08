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
  }),
}));

vi.mock('../../src/llm/provider.js', () => ({
  complete: vi.fn(),
}));

import { isSimpleChat } from '../../src/router/heuristics.js';
import { routeMessage } from '../../src/router/messageRouter.js';
import { handleCommand } from '../../src/channels/handlers/commands.js';
import { handleSystemCommand } from '../../src/channels/handlers/systemCommands.js';
import { handleProfileCommand } from '../../src/channels/handlers/profileCommands.js';
import { handleHeartbeatCommand } from '../../src/channels/handlers/heartbeatCommands.js';
import { handleChat } from '../../src/channels/handlers/chat.js';
import { handleInboundMessage } from '../../src/channels/handlers/message.js';
import { initTemplates } from '../../src/planner/templates.js';
import { graphEvents } from '../../src/core/events.js';
import { complete } from '../../src/llm/provider.js';

const mockComplete = vi.mocked(complete);

describe('Phase 7: Message Router', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');
    runMigrations(testDb);
    initTemplates();
  });

  afterEach(async () => {
    graphEvents.removeAllListeners();
    // Wait for any fire-and-forget executeJob calls to settle
    await new Promise(resolve => setTimeout(resolve, 50));
    testDb.close();
  });

  // === HEURISTICS ===
  describe('isSimpleChat', () => {
    it('should detect greetings', () => {
      expect(isSimpleChat('hello')).toBe(true);
      expect(isSimpleChat('Hi there!')).toBe(true);
      expect(isSimpleChat('hey')).toBe(true);
      expect(isSimpleChat('Good morning')).toBe(true);
    });

    it('should detect gratitude', () => {
      expect(isSimpleChat('thanks!')).toBe(true);
      expect(isSimpleChat('Thank you so much')).toBe(true);
    });

    it('should detect simple questions', () => {
      expect(isSimpleChat('what is TypeScript?')).toBe(true);
      expect(isSimpleChat('how do I use git?')).toBe(true);
    });

    it('should detect acknowledgments', () => {
      expect(isSimpleChat('ok')).toBe(true);
      expect(isSimpleChat('got it')).toBe(true);
      expect(isSimpleChat('cool')).toBe(true);
    });

    it('should NOT detect complex requests', () => {
      expect(isSimpleChat('check my email and schedule follow-ups')).toBe(false);
      expect(isSimpleChat('research quantum computing and write a report')).toBe(false);
      expect(isSimpleChat('send an email to John about the meeting')).toBe(false);
    });

    it('should treat empty/short text as chat', () => {
      expect(isSimpleChat('')).toBe(true);
      expect(isSimpleChat('hi')).toBe(true);
    });
  });

  // === MESSAGE ROUTER ===
  describe('routeMessage', () => {
    it('should route slash commands', () => {
      expect(routeMessage('/inbox')).toBe('command');
      expect(routeMessage('/status')).toBe('command');
      expect(routeMessage('/research AI trends')).toBe('command');
    });

    it('should route simple chat', () => {
      expect(routeMessage('hello!')).toBe('chat');
      expect(routeMessage('thanks')).toBe('chat');
      expect(routeMessage('ok')).toBe('chat');
    });

    it('should route complex requests', () => {
      expect(routeMessage('check my email and draft replies')).toBe('complex');
      expect(routeMessage('research AI trends and write posts about it')).toBe('complex');
    });
  });

  // === COMMAND HANDLER ===
  describe('handleCommand', () => {
    it('should handle /inbox command', async () => {
      const messages: string[] = [];
      const ctx = {
        channelName: 'telegram',
        chatId: 'u1',
        sendMessage: async (text: string) => { messages.push(text); },
      };

      const handled = await handleCommand('/inbox', ctx);
      expect(handled).toBe(true);
      expect(messages[0]).toContain('Inbox Assistant');
    });

    it('should handle /research with args', async () => {
      const messages: string[] = [];
      const ctx = {
        channelName: 'telegram',
        chatId: 'u1',
        sendMessage: async (text: string) => { messages.push(text); },
      };

      const handled = await handleCommand('/research quantum computing', ctx);
      expect(handled).toBe(true);
      expect(messages[0]).toContain('Deep Research');
    });

    it('should reject missing required slots', async () => {
      const messages: string[] = [];
      const ctx = {
        channelName: 'telegram',
        chatId: 'u1',
        sendMessage: async (text: string) => { messages.push(text); },
      };

      // /send requires draftId
      const handled = await handleCommand('/send', ctx);
      expect(handled).toBe(true);
      expect(messages[0]).toContain('Missing required');
    });

    it('should return false for unknown commands', async () => {
      const ctx = {
        channelName: 'telegram',
        chatId: 'u1',
        sendMessage: async () => {},
      };
      const handled = await handleCommand('/unknown', ctx);
      expect(handled).toBe(false);
    });
  });

  // === SYSTEM COMMANDS ===
  describe('systemCommands', () => {
    it('should handle /status', async () => {
      const messages: string[] = [];
      const ctx = {
        channelName: 'telegram',
        chatId: 'u1',
        sendMessage: async (text: string) => { messages.push(text); },
      };

      const handled = await handleSystemCommand('/status', '', ctx);
      expect(handled).toBe(true);
      expect(messages[0]).toContain('Status');
    });

    it('should handle /budget', async () => {
      const messages: string[] = [];
      const ctx = {
        channelName: 'telegram',
        chatId: 'u1',
        sendMessage: async (text: string) => { messages.push(text); },
      };

      const handled = await handleSystemCommand('/budget', '', ctx);
      expect(handled).toBe(true);
      expect(messages[0]).toContain('Budget');
    });

    it('should handle /jobs with no jobs', async () => {
      const messages: string[] = [];
      const ctx = {
        channelName: 'telegram',
        chatId: 'u1',
        sendMessage: async (text: string) => { messages.push(text); },
      };

      const handled = await handleSystemCommand('/jobs', '', ctx);
      expect(handled).toBe(true);
      expect(messages[0]).toContain('No recent jobs');
    });

    it('should handle /templates', async () => {
      const messages: string[] = [];
      const ctx = {
        channelName: 'telegram',
        chatId: 'u1',
        sendMessage: async (text: string) => { messages.push(text); },
      };

      const handled = await handleSystemCommand('/templates', '', ctx);
      expect(handled).toBe(true);
      expect(messages[0]).toContain('Templates');
    });
  });

  // === PROFILE COMMANDS ===
  describe('profileCommands', () => {
    it('should handle /remember', async () => {
      const messages: string[] = [];
      const ctx = {
        channelName: 'telegram',
        chatId: 'u1',
        sendMessage: async (text: string) => { messages.push(text); },
      };

      const handled = await handleProfileCommand('/remember', 'I prefer dark mode', ctx);
      expect(handled).toBe(true);
      expect(messages[0]).toContain('Remembered');
    });

    it('should handle /remember without args', async () => {
      const messages: string[] = [];
      const ctx = {
        channelName: 'telegram',
        chatId: 'u1',
        sendMessage: async (text: string) => { messages.push(text); },
      };

      const handled = await handleProfileCommand('/remember', '', ctx);
      expect(handled).toBe(true);
      expect(messages[0]).toContain('Usage');
    });
  });

  // === HEARTBEAT COMMANDS ===
  describe('heartbeatCommands', () => {
    it('should handle /heartbeat list', async () => {
      const messages: string[] = [];
      const ctx = {
        channelName: 'telegram',
        chatId: 'u1',
        sendMessage: async (text: string) => { messages.push(text); },
      };

      const handled = await handleHeartbeatCommand('/heartbeat', 'list', ctx);
      expect(handled).toBe(true);
      expect(messages[0]).toContain('Heartbeat');
    });

    it('should handle /heartbeat add', async () => {
      const messages: string[] = [];
      const ctx = {
        channelName: 'telegram',
        chatId: 'u1',
        sendMessage: async (text: string) => { messages.push(text); },
      };

      const handled = await handleHeartbeatCommand('/heartbeat', 'add check for overdue invoices', ctx);
      expect(handled).toBe(true);
      expect(messages[0]).toContain('added');
    });
  });

  // === CHAT HANDLER ===
  describe('handleChat', () => {
    it('should respond with fast-tier LLM', async () => {
      const messages: string[] = [];
      mockComplete.mockResolvedValueOnce({
        text: 'Hello! How can I help you today?',
        usage: { total_tokens: 50 },
      });

      await handleChat('hello', {
        channelName: 'telegram',
        chatId: 'u1',
        sendMessage: async (text: string) => { messages.push(text); },
      });

      expect(messages[0]).toBe('Hello! How can I help you today?');
    });
  });

  // === SHARED MESSAGE HANDLER ===
  describe('handleInboundMessage', () => {
    it('should reject unauthorized users', async () => {
      const messages: string[] = [];
      await handleInboundMessage(
        { channelName: 'telegram', chatId: 'chat1', userId: 'bad_user', text: 'hello' },
        {
          sendMessage: async (chatId, text) => { messages.push(text); },
          isAuthorized: () => false,
        },
      );
      expect(messages[0]).toBe('Unauthorized.');
    });

    it('should route chat messages', async () => {
      const messages: string[] = [];
      mockComplete.mockResolvedValueOnce({
        text: 'Hi there!',
        usage: { total_tokens: 30 },
      });

      await handleInboundMessage(
        { channelName: 'telegram', chatId: 'chat1', userId: 'user1', text: 'hello' },
        {
          sendMessage: async (chatId, text) => { messages.push(text); },
          isAuthorized: () => true,
        },
      );
      expect(messages[0]).toBe('Hi there!');
    });

    it('should route command messages', async () => {
      const messages: string[] = [];
      await handleInboundMessage(
        { channelName: 'telegram', chatId: 'chat1', userId: 'user1', text: '/status' },
        {
          sendMessage: async (chatId, text) => { messages.push(text); },
          isAuthorized: () => true,
        },
      );
      expect(messages[0]).toContain('Status');
    });

    it('should handle unknown commands', async () => {
      const messages: string[] = [];
      await handleInboundMessage(
        { channelName: 'telegram', chatId: 'chat1', userId: 'user1', text: '/foobar' },
        {
          sendMessage: async (chatId, text) => { messages.push(text); },
          isAuthorized: () => true,
        },
      );
      expect(messages[0]).toContain('Unknown command');
    });
  });
});

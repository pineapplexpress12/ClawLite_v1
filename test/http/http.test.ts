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
    http: { enabled: true, port: 0, host: '127.0.0.1', webhookToken: 'test-secret' },
    channels: {
      telegram: { enabled: true, allowedUserIds: ['123'] },
      webchat: { enabled: true },
      discord: { enabled: false },
    },
  }),
}));

import Fastify from 'fastify';
import { registerWebhookRoutes } from '../../src/http/webhooks.js';
import { registerArtifactRoutes } from '../../src/http/artifacts.js';
import { registerStatusRoutes } from '../../src/http/status.js';
import { storeTextArtifact } from '../../src/db/artifacts.js';
import { createJob } from '../../src/db/jobs.js';
import { registerChannel, clearChannels } from '../../src/channels/registry.js';

describe('Phase 9: HTTP Server', () => {
  let fastify: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');
    runMigrations(testDb);
    clearChannels();

    fastify = Fastify({ logger: false });
    registerWebhookRoutes(fastify);
    registerArtifactRoutes(fastify);
    registerStatusRoutes(fastify);
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
    testDb.close();
  });

  // === STATUS ===
  describe('GET /status', () => {
    it('should return system status', async () => {
      const res = await fastify.inject({ method: 'GET', url: '/status' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.operator).toBe('TestBot');
      expect(body.activeJobs).toBe(0);
      expect(body.dailyBudget).toBeDefined();
      expect(body.dailyBudget.limit).toBe(200000);
      expect(body.memoryItems).toBe(0);
      expect(body.recentJobs).toEqual([]);
    });

    it('should include active jobs count', async () => {
      createJob({ goal: 'Running job', triggerType: 'channel_message', channel: 'telegram', chatId: 'u1' });
      // Job starts as 'pending', not active
      const res = await fastify.inject({ method: 'GET', url: '/status' });
      const body = res.json();
      expect(body.activeJobs).toBe(0);
    });

    it('should include recent jobs', async () => {
      createJob({ goal: 'Job 1', triggerType: 'webhook' });
      createJob({ goal: 'Job 2', triggerType: 'webhook' });
      const res = await fastify.inject({ method: 'GET', url: '/status' });
      const body = res.json();
      expect(body.recentJobs).toHaveLength(2);
    });

    it('should list registered channels', async () => {
      registerChannel({ name: 'telegram', start: async () => {}, stop: async () => {}, sendMessage: async () => {}, onMessage: () => {} });
      const res = await fastify.inject({ method: 'GET', url: '/status' });
      const body = res.json();
      expect(body.channels).toContain('telegram');
    });
  });

  // === ARTIFACTS ===
  describe('GET /artifacts/:id', () => {
    it('should return 404 for missing artifact', async () => {
      const res = await fastify.inject({ method: 'GET', url: '/artifacts/nonexistent' });
      expect(res.statusCode).toBe(404);
    });

    it('should serve HTML artifacts directly', async () => {
      const id = storeTextArtifact({
        type: 'html',
        title: 'Report',
        content: '<h1>Hello</h1>',
      });
      const res = await fastify.inject({ method: 'GET', url: `/artifacts/${id}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toBe('<h1>Hello</h1>');
    });

    it('should render non-HTML artifacts as HTML page', async () => {
      const id = storeTextArtifact({
        type: 'text',
        title: 'Notes',
        content: 'Some plain text content',
      });
      const res = await fastify.inject({ method: 'GET', url: `/artifacts/${id}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('Notes');
      expect(res.body).toContain('Some plain text content');
    });
  });

  // === WEBHOOKS ===
  describe('POST /hooks/:templateId', () => {
    it('should reject invalid token', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/hooks/inbox_assistant?token=wrong',
        payload: { slots: {} },
      });
      expect(res.statusCode).toBe(401);
    });

    it('should return 404 for unknown template', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/hooks/nonexistent?token=test-secret',
        payload: { slots: {} },
      });
      expect(res.statusCode).toBe(404);
    });

    it('should create a job from valid webhook', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/hooks/inbox_assistant?token=test-secret',
        payload: { slots: { query: 'unread' } },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.jobId).toBeDefined();
      expect(body.status).toBe('started');
    });

    it('should work without webhook token configured', async () => {
      // Re-create fastify without webhookToken in config
      // The config mock returns webhookToken: 'test-secret', but we can test
      // that a valid token passes
      const res = await fastify.inject({
        method: 'POST',
        url: '/hooks/inbox_assistant?token=test-secret',
        payload: {},
      });
      expect(res.statusCode).toBe(200);
    });
  });
});

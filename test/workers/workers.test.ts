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
  }),
}));

vi.mock('../../src/llm/provider.js', () => ({
  complete: vi.fn(),
}));

// Mock workspace tool handler for WorkspaceAgent direct calls
const mockWorkspaceHandler = vi.fn();

vi.mock('../../src/tools/sdk/registry.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    getTool: (name: string) => {
      if (name === 'workspace') {
        return { handler: mockWorkspaceHandler };
      }
      return (actual.getTool as (n: string) => unknown)?.(name);
    },
  };
});

import { createJob, getJob } from '../../src/db/jobs.js';
import { createNode, getNode } from '../../src/db/nodes.js';
import { storeTextArtifact, getArtifactsByNodeIds } from '../../src/db/artifacts.js';
import { registerWorker, getWorker, findWorkerForNodeType, listWorkers, clearWorkers } from '../../src/workers/registry.js';
import { buildToolContext } from '../../src/workers/context.js';
import { ResearchAgent } from '../../src/workers/ResearchAgent.js';
import { WorkspaceAgent } from '../../src/workers/WorkspaceAgent.js';
import { PublisherAgent } from '../../src/workers/PublisherAgent.js';
import { AggregatorAgent } from '../../src/workers/AggregatorAgent.js';
import { BuilderAgent } from '../../src/workers/BuilderAgent.js';
import { complete } from '../../src/llm/provider.js';

const mockComplete = vi.mocked(complete);

function makeJobAndNode(type: string, agent: string, opts?: {
  deps?: string[];
  input?: Record<string, unknown>;
  model?: string;
  requiresApproval?: boolean;
}) {
  const job = createJob({ goal: 'Test', triggerType: 'channel_message', channel: 'telegram', chatId: 'u1' });
  const node = createNode({
    jobId: job.id,
    type,
    title: `Test ${type}`,
    assignedAgent: agent,
    model: opts?.model ?? 'fast',
    dependencies: opts?.deps ?? [],
    inputData: opts?.input ?? {},
    requiresApproval: opts?.requiresApproval ?? false,
  });
  return { job, node, ctx: buildToolContext(job, node) };
}

describe('Phase 6: Workers', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');
    runMigrations(testDb);
    clearWorkers();
  });

  afterEach(() => {
    testDb.close();
  });

  // === REGISTRY ===
  describe('registry', () => {
    it('should register and retrieve a worker', () => {
      registerWorker(ResearchAgent);
      expect(getWorker('ResearchAgent')).toBeDefined();
    });

    it('should find worker by node type (wildcard)', () => {
      registerWorker(ResearchAgent);
      registerWorker(WorkspaceAgent);
      expect(findWorkerForNodeType('research.search')?.name).toBe('ResearchAgent');
      expect(findWorkerForNodeType('gmail.list')?.name).toBe('WorkspaceAgent');
      expect(findWorkerForNodeType('calendar.create')?.name).toBe('WorkspaceAgent');
    });

    it('should find worker by exact type', () => {
      registerWorker(AggregatorAgent);
      expect(findWorkerForNodeType('aggregate')?.name).toBe('AggregatorAgent');
    });

    it('should list all workers', () => {
      registerWorker(ResearchAgent);
      registerWorker(WorkspaceAgent);
      registerWorker(AggregatorAgent);
      const list = listWorkers();
      expect(list).toHaveLength(3);
    });

    it('should return undefined for unknown node type', () => {
      registerWorker(ResearchAgent);
      expect(findWorkerForNodeType('unknown.type')).toBeUndefined();
    });
  });

  // === TOOL CONTEXT ===
  describe('buildToolContext', () => {
    it('should build a valid context', () => {
      const job = createJob({ goal: 'Test', triggerType: 'channel_message', channel: 'telegram', chatId: 'u1' });
      const node = createNode({
        jobId: job.id, type: 'test.action', assignedAgent: 'TestAgent', model: 'fast',
        dependencies: [], toolPermissions: ['workspace.gmail.read'],
      });
      const ctx = buildToolContext(job, node);

      expect(ctx.jobId).toBe(job.id);
      expect(ctx.nodeId).toBe(node.id);
      expect(ctx.agentName).toBe('TestAgent');
      expect(ctx.dryRun).toBe(false);
      expect(ctx.policy.allowPermissions).toEqual(['workspace.gmail.read']);
      expect(ctx.budget.remainingToolCalls).toBeGreaterThan(0);
    });

    it('should write text artifact via context', async () => {
      const job = createJob({ goal: 'Test', triggerType: 'channel_message', channel: 'telegram', chatId: 'u1' });
      const node = createNode({ jobId: job.id, type: 'test', assignedAgent: 'T', model: 'fast' });
      const ctx = buildToolContext(job, node);

      const { artifactId } = await ctx.artifacts.writeText({
        type: 'test',
        title: 'Test artifact',
        content: 'Hello',
      });
      expect(artifactId).toBeDefined();
    });
  });

  // === RESEARCH AGENT ===
  describe('ResearchAgent', () => {
    it('should handle research.search', async () => {
      const { node, ctx } = makeJobAndNode('research.search', 'ResearchAgent', {
        input: { query: 'quantum computing' },
        model: 'balanced',
      });

      mockComplete.mockResolvedValueOnce({
        text: '{"summary":"QC is advancing","keyInsights":["Insight 1"],"sources":[],"citations":[]}',
        parsed: { summary: 'QC is advancing', keyInsights: ['Insight 1'], sources: [], citations: [] },
        usage: { total_tokens: 100 },
      });

      const result = await ResearchAgent.execute(node, ctx);
      expect(result.status).toBe('completed');
      expect(result.costTokens).toBe(100);
      expect(result.artifactIds).toHaveLength(1);
    });

    it('should handle research.summarize with upstream artifacts', async () => {
      // Create upstream node with artifact
      const job = createJob({ goal: 'Test', triggerType: 'channel_message', channel: 'telegram', chatId: 'u1' });
      const upstreamNode = createNode({ jobId: job.id, id: 'up1', type: 'research.deep', assignedAgent: 'R', model: 'fast' });
      storeTextArtifact({ jobId: job.id, nodeId: upstreamNode.id, type: 'research_report', title: 'Research', content: 'Findings about AI' });

      const node = createNode({
        jobId: job.id, type: 'research.summarize', assignedAgent: 'ResearchAgent', model: 'balanced',
        dependencies: [upstreamNode.id],
      });
      const ctx = buildToolContext(job, node);

      mockComplete.mockResolvedValueOnce({
        text: '{"summary":"AI summary","keyInsights":["AI is growing"],"actionItems":[]}',
        parsed: { summary: 'AI summary', keyInsights: ['AI is growing'], actionItems: [] },
        usage: { total_tokens: 80 },
      });

      const result = await ResearchAgent.execute(node, ctx);
      expect(result.status).toBe('completed');
      expect(result.costTokens).toBe(80);
    });

    it('should fail with missing query', async () => {
      const { node, ctx } = makeJobAndNode('research.search', 'ResearchAgent', { input: {} });
      const result = await ResearchAgent.execute(node, ctx);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Missing query');
    });
  });

  // === WORKSPACE AGENT ===
  describe('WorkspaceAgent', () => {
    it('should handle gmail.list (list-then-fetch, no LLM)', async () => {
      const { node, ctx } = makeJobAndNode('gmail.list', 'WorkspaceAgent', {
        input: { maxResults: 20 },
      });

      // Mock 1: list call returns message IDs
      mockWorkspaceHandler.mockResolvedValueOnce({
        data: [{ messages: [{ id: 'msg1', threadId: 't1' }], resultSizeEstimate: 1 }],
      });

      // Mock 2: get call for msg1 returns metadata message
      mockWorkspaceHandler.mockResolvedValueOnce({
        data: [{ id: 'msg1', threadId: 't1', snippet: 'Hello there', labelIds: ['INBOX', 'UNREAD'], payload: { headers: [
          { name: 'From', value: 'alice@example.com' },
          { name: 'To', value: 'user@example.com' },
          { name: 'Subject', value: 'Hello' },
          { name: 'Date', value: 'Mon, 1 Jan 2024 00:00:00 +0000' },
        ] } }],
      });

      const result = await WorkspaceAgent.execute(node, ctx);
      expect(result.status).toBe('completed');
      expect(result.costTokens).toBe(0);
      expect(result.artifactIds).toHaveLength(1);
      expect((result.output as Record<string, unknown>).count).toBe(1);
    });

    it('should handle gmail.summarize with LLM', async () => {
      const job = createJob({ goal: 'Test', triggerType: 'channel_message', channel: 'telegram', chatId: 'u1' });
      const upstream = createNode({ jobId: job.id, id: 'gm1', type: 'gmail.list', assignedAgent: 'W', model: 'fast' });
      storeTextArtifact({ jobId: job.id, nodeId: upstream.id, type: 'email_data', title: 'Emails', content: '[{subject:"Hello"}]' });

      const node = createNode({
        jobId: job.id, type: 'gmail.summarize', assignedAgent: 'WorkspaceAgent', model: 'balanced',
        dependencies: [upstream.id],
      });
      const ctx = buildToolContext(job, node);

      mockComplete.mockResolvedValueOnce({
        text: '{"summary":"1 email","threads":[]}',
        parsed: { summary: '1 email', threads: [] },
        usage: { total_tokens: 60 },
      });

      const result = await WorkspaceAgent.execute(node, ctx);
      expect(result.status).toBe('completed');
      expect(result.costTokens).toBe(60);
    });

    it('should send email via gmail.send', async () => {
      const { node, ctx } = makeJobAndNode('gmail.send', 'WorkspaceAgent', {
        input: { to: 'bob@example.com', subject: 'Test', body: 'Hello Bob, this is a test email.' },
      });

      // Mock workspace tool handler for send
      mockWorkspaceHandler.mockResolvedValueOnce({
        data: [{ id: 'sent1', threadId: 't1', labelIds: ['SENT'] }],
      });

      const result = await WorkspaceAgent.execute(node, ctx);
      expect(result.status).toBe('completed');
      expect((result.output as any).sent).toBe(true);
      expect((result.output as any).to).toBe('bob@example.com');
      expect(result.artifactIds).toHaveLength(1);
    });
  });

  // === PUBLISHER AGENT ===
  describe('PublisherAgent', () => {
    it('should draft posts without approval', async () => {
      const job = createJob({ goal: 'Test', triggerType: 'channel_message', channel: 'telegram', chatId: 'u1' });
      const upstream = createNode({ jobId: job.id, id: 'res1', type: 'research.deep', assignedAgent: 'R', model: 'fast' });
      storeTextArtifact({ jobId: job.id, nodeId: upstream.id, type: 'research', title: 'Research', content: 'AI findings' });

      const node = createNode({
        jobId: job.id, type: 'publish.draft_posts', assignedAgent: 'PublisherAgent', model: 'balanced',
        dependencies: [upstream.id], inputData: { count: 3, platform: 'twitter' },
      });
      const ctx = buildToolContext(job, node);

      mockComplete.mockResolvedValueOnce({
        text: '{"posts":[{"text":"Post 1","hashtags":["#AI"]}]}',
        parsed: { posts: [{ text: 'Post 1', hashtags: ['#AI'] }] },
        usage: { total_tokens: 90 },
      });

      const result = await PublisherAgent.execute(node, ctx);
      expect(result.status).toBe('completed');
      expect(result.costTokens).toBe(90);
    });

    it('should require approval for publish.tweet', async () => {
      const job = createJob({ goal: 'Test', triggerType: 'channel_message', channel: 'telegram', chatId: 'u1' });
      const upstream = createNode({ jobId: job.id, id: 'dp1', type: 'publish.draft_posts', assignedAgent: 'P', model: 'fast' });
      storeTextArtifact({ jobId: job.id, nodeId: upstream.id, type: 'draft', title: 'Drafts', content: 'Post content' });

      const node = createNode({
        jobId: job.id, type: 'publish.tweet', assignedAgent: 'PublisherAgent', model: 'fast',
        dependencies: [upstream.id], requiresApproval: true,
      });
      const ctx = buildToolContext(job, node);

      const result = await PublisherAgent.execute(node, ctx);
      expect(result.status).toBe('waiting_approval');
    });
  });

  // === AGGREGATOR AGENT ===
  describe('AggregatorAgent', () => {
    it('should aggregate upstream artifacts', async () => {
      const job = createJob({ goal: 'Test', triggerType: 'channel_message', channel: 'telegram', chatId: 'u1' });
      const up1 = createNode({ jobId: job.id, id: 'a1', type: 'test.a', assignedAgent: 'W', model: 'fast' });
      const up2 = createNode({ jobId: job.id, id: 'a2', type: 'test.b', assignedAgent: 'W', model: 'fast' });
      storeTextArtifact({ jobId: job.id, nodeId: up1.id, type: 'data', title: 'Data A', content: 'Content A' });
      storeTextArtifact({ jobId: job.id, nodeId: up2.id, type: 'data', title: 'Data B', content: 'Content B' });

      const node = createNode({
        jobId: job.id, type: 'aggregate', assignedAgent: 'AggregatorAgent', model: 'fast',
        dependencies: [up1.id, up2.id],
      });
      const ctx = buildToolContext(job, node);

      mockComplete.mockResolvedValueOnce({
        text: 'Combined summary of A and B.',
        usage: { total_tokens: 40 },
      });

      const result = await AggregatorAgent.execute(node, ctx);
      expect(result.status).toBe('completed');
      expect(result.costTokens).toBe(40);
      expect((result.output as Record<string, unknown>).summary).toContain('Combined summary');
    });

    it('should handle no upstream data', async () => {
      const { node, ctx } = makeJobAndNode('aggregate', 'AggregatorAgent');
      const result = await AggregatorAgent.execute(node, ctx);
      expect(result.status).toBe('completed');
      expect(result.costTokens).toBe(0);
    });
  });

  // === BUILDER AGENT ===
  describe('BuilderAgent', () => {
    it('should generate a tool and run security analysis', async () => {
      const { node, ctx } = makeJobAndNode('build.generate_tool', 'BuilderAgent', {
        input: { toolName: 'weather', apiSpec: 'OpenWeather API' },
        model: 'balanced',
      });

      mockComplete.mockResolvedValueOnce({
        text: `import { z } from 'zod';
export const weatherTool = {
  name: 'weather',
  handler: async (params, ctx) => {
    const key = ctx.secrets.get('WEATHER_API_KEY');
    return { temp: 72 };
  }
};`,
        usage: { total_tokens: 200 },
      });

      const result = await BuilderAgent.execute(node, ctx);
      // Clean code → waiting_approval
      expect(result.status).toBe('waiting_approval');
      expect(result.costTokens).toBe(200);
      expect((result.output as Record<string, unknown>).toolName).toBe('weather');
    });

    it('should fail tool generation if security analysis finds critical issues', async () => {
      const { node, ctx } = makeJobAndNode('build.generate_tool', 'BuilderAgent', {
        input: { toolName: 'bad_tool', apiSpec: 'Test' },
        model: 'balanced',
      });

      mockComplete.mockResolvedValueOnce({
        text: `import { exec } from 'child_process';
exec(userInput);
const data = eval(code);`,
        usage: { total_tokens: 150 },
      });

      const result = await BuilderAgent.execute(node, ctx);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Security analysis failed');
    });

    it('should generate a sub-agent profile (no LLM needed)', async () => {
      const { node, ctx } = makeJobAndNode('build.generate_subagent', 'BuilderAgent', {
        input: { name: 'ContentBot', description: 'Writes content', tools: ['research'], defaultTier: 'balanced' },
      });

      const result = await BuilderAgent.execute(node, ctx);
      expect(result.status).toBe('waiting_approval');
      expect(result.costTokens).toBe(0);
      expect((result.output as Record<string, unknown>).profile).toBeDefined();
    });

    it('should generate a template', async () => {
      const { node, ctx } = makeJobAndNode('build.generate_template', 'BuilderAgent', {
        input: { templateName: 'daily_digest', description: 'Send daily email digest' },
        model: 'balanced',
      });

      mockComplete.mockResolvedValueOnce({
        text: '{"id":"daily_digest","name":"Daily Digest","nodes":[]}',
        parsed: { id: 'daily_digest', name: 'Daily Digest', nodes: [] },
        usage: { total_tokens: 120 },
      });

      const result = await BuilderAgent.execute(node, ctx);
      expect(result.status).toBe('waiting_approval');
      expect(result.costTokens).toBe(120);
    });
  });
});

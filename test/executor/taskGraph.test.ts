import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/schema.js';

// --- In-memory DB setup ---
let testDb: Database.Database;

vi.mock('../../src/db/connection.js', () => ({
  getDb: () => testDb,
  getClawliteHome: () => '/tmp/clawlite-test',
}));

// Mock config
vi.mock('../../src/core/config.js', () => ({
  getConfig: () => ({
    llm: { provider: 'openrouter', tiers: { fast: 'gpt-4o-mini', balanced: 'gpt-4o', strong: 'claude-opus' } },
    budgets: { dailyTokens: 200000, perJobTokens: 50000, maxToolCallsPerJob: 200 },
    hardLimits: {
      maxNodesPerJob: 20,
      maxTotalLLMCalls: 30,
      maxJobDurationMs: 300000,
      maxRetriesTotalPerJob: 10,
      agenticMaxIterations: 5,
      agenticMaxNodes: 10,
      agenticMaxTokenBudget: 30000,
    },
    session: { turnsInjectedIntoChat: 5, maxTurnsInMemory: 20, compactionThresholdTokens: 8000 },
  }),
}));

// Mock LLM provider
vi.mock('../../src/llm/provider.js', () => ({
  complete: vi.fn(),
}));

import { createJob, getJob, updateJobStatus, incrementJobLLMCalls } from '../../src/db/jobs.js';
import { createNode, createNodes, getNode, getNodesByJobId, transitionNodeStatus, countNodes } from '../../src/db/nodes.js';
import { insertRun, completeRun } from '../../src/db/runs.js';
import { getDailyBudget, incrementDailyTokens, resetDailyBudget } from '../../src/db/dailyBudget.js';

// Planner modules
import { initTemplates, getTemplate, getAllTemplates, getTemplateBySlashCommand, registerTemplate } from '../../src/planner/templates.js';
import { selectTemplate } from '../../src/planner/templateSelector.js';
import { extractSlots, extractSlashArgs } from '../../src/planner/slotExtractor.js';
import { buildTaskGraph } from '../../src/planner/buildTaskGraph.js';

// Executor modules
import { validateDAG } from '../../src/executor/graphValidation.js';
import { topologicalSort, isAcyclic } from '../../src/executor/topologicalSort.js';
import { checkCircuitBreakers, checkDailyBudget } from '../../src/executor/circuitBreakers.js';
import { requestApproval, resolveApproval } from '../../src/executor/approvalHandler.js';
import { runNode, setWorkerExecutor } from '../../src/executor/runNode.js';
import { executeJob } from '../../src/executor/executeJob.js';
import { graphEvents } from '../../src/core/events.js';
import { complete } from '../../src/llm/provider.js';

const mockComplete = vi.mocked(complete);

function makeJob(goal = 'Test goal'): string {
  const job = createJob({ goal, triggerType: 'channel_message', channel: 'telegram', chatId: 'u1' });
  return job.id;
}

describe('Phase 5: Task Graph Engine', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');
    runMigrations(testDb);
    initTemplates();
  });

  afterEach(() => {
    graphEvents.removeAllListeners();
    testDb.close();
  });

  // === TEMPLATES ===
  describe('templates', () => {
    it('should have 8 built-in templates', () => {
      const all = getAllTemplates();
      expect(all.length).toBe(8);
    });

    it('should get template by ID', () => {
      const t = getTemplate('inbox_assistant');
      expect(t).toBeDefined();
      expect(t!.name).toBe('Inbox Assistant');
      expect(t!.slashCommand).toBe('/inbox');
    });

    it('should get template by slash command', () => {
      const t = getTemplateBySlashCommand('/inbox');
      expect(t).toBeDefined();
      expect(t!.id).toBe('inbox_assistant');
    });

    it('should get template by slash command with args', () => {
      const t = getTemplateBySlashCommand('/research quantum computing');
      expect(t).toBeDefined();
      expect(t!.id).toBe('deep_research');
    });

    it('should register a custom template', () => {
      registerTemplate({
        id: 'custom_test',
        name: 'Custom Test',
        description: 'A test template',
        alternateMatches: [],
        slots: [],
        nodes: [],
      });
      expect(getTemplate('custom_test')).toBeDefined();
      expect(getAllTemplates().length).toBe(9);
    });
  });

  // === TEMPLATE SELECTOR ===
  describe('templateSelector', () => {
    it('should match slash command with 100% confidence', async () => {
      const result = await selectTemplate('/inbox');
      expect(result.template).toBeDefined();
      expect(result.template!.id).toBe('inbox_assistant');
      expect(result.confidence).toBe(1.0);
      expect(result.fallback).toBe('none');
    });

    it('should match slash command with args', async () => {
      const result = await selectTemplate('/research AI trends');
      expect(result.template!.id).toBe('deep_research');
      expect(result.confidence).toBe(1.0);
    });

    it('should use LLM for natural language with high confidence', async () => {
      mockComplete.mockResolvedValueOnce({
        text: '{}',
        parsed: { templateId: 'inbox_assistant', confidence: 0.9, topCandidates: ['inbox_assistant'] },
        usage: { total_tokens: 50 },
      });
      const result = await selectTemplate('check my email please');
      expect(result.template!.id).toBe('inbox_assistant');
      expect(result.confidence).toBe(0.9);
      expect(result.fallback).toBe('none');
    });

    it('should fall back to agentic for medium confidence', async () => {
      mockComplete.mockResolvedValueOnce({
        text: '{}',
        parsed: { templateId: 'inbox_assistant', confidence: 0.5, topCandidates: ['inbox_assistant'] },
        usage: { total_tokens: 50 },
      });
      const result = await selectTemplate('do something with my messages');
      expect(result.fallback).toBe('agentic');
    });

    it('should fall back to chat for low confidence', async () => {
      mockComplete.mockResolvedValueOnce({
        text: '{}',
        parsed: { templateId: 'none', confidence: 0, topCandidates: [] },
        usage: { total_tokens: 50 },
      });
      const result = await selectTemplate('hello how are you?');
      expect(result.template).toBeNull();
      expect(result.fallback).toBe('chat');
    });

    it('should return unknown slash command as not matched', async () => {
      mockComplete.mockResolvedValueOnce({
        text: '{}',
        parsed: { templateId: 'none', confidence: 0, topCandidates: [] },
        usage: { total_tokens: 50 },
      });
      const result = await selectTemplate('/unknown_command');
      // Not a known slash command, falls through to LLM
      expect(result.fallback).toBe('chat');
    });
  });

  // === SLOT EXTRACTOR ===
  describe('slotExtractor', () => {
    it('should extract slots via LLM', async () => {
      const template = getTemplate('deep_research')!;
      mockComplete.mockResolvedValueOnce({
        text: '{}',
        parsed: { query: 'quantum computing breakthroughs' },
        usage: { total_tokens: 30 },
      });
      const slots = await extractSlots(template, 'research quantum computing breakthroughs');
      expect(slots.query).toBe('quantum computing breakthroughs');
    });

    it('should apply defaults for missing optional slots', async () => {
      const template = getTemplate('inbox_assistant')!;
      mockComplete.mockResolvedValueOnce({
        text: '{}',
        parsed: { maxResults: null },
        usage: { total_tokens: 30 },
      });
      const slots = await extractSlots(template, 'check my inbox');
      expect(slots.maxResults).toBe(20); // default value
    });

    it('should return empty for templates with no slots', async () => {
      registerTemplate({
        id: 'no_slots',
        name: 'No Slots',
        description: 'Test',
        alternateMatches: [],
        slots: [],
        nodes: [],
      });
      const slots = await extractSlots(getTemplate('no_slots')!, 'anything');
      expect(slots).toEqual({});
    });

    it('should extract slash args for single required slot', () => {
      const template = getTemplate('deep_research')!;
      const slots = extractSlashArgs(template, 'quantum computing');
      expect(slots.query).toBe('quantum computing');
    });

    it('should apply defaults in slash args', () => {
      const template = getTemplate('inbox_assistant')!;
      const slots = extractSlashArgs(template, '');
      expect(slots.maxResults).toBe(20);
    });
  });

  // === BUILD TASK GRAPH ===
  describe('buildTaskGraph', () => {
    it('should create job and nodes from template', () => {
      const template = getTemplate('inbox_assistant')!;
      const result = buildTaskGraph({
        template,
        slots: { maxResults: 10 },
        triggerType: 'channel_message',
        channel: 'telegram',
        chatId: 'user1',
      });

      expect(result.jobId).toBeDefined();
      expect(result.nodeIds).toHaveLength(3);

      const job = getJob(result.jobId);
      expect(job).toBeDefined();
      expect(job!.goal).toBe('List unread emails');

      const nodes = getNodesByJobId(result.jobId);
      expect(nodes).toHaveLength(3);
    });

    it('should resolve slot placeholders in node inputs', () => {
      const template = getTemplate('inbox_assistant')!;
      const result = buildTaskGraph({
        template,
        slots: { maxResults: 15 },
        triggerType: 'channel_message',
        channel: 'telegram',
        chatId: 'user1',
      });

      const nodes = getNodesByJobId(result.jobId);
      const gmailNode = nodes.find(n => n.type === 'gmail.list')!;
      const inputData = JSON.parse(gmailNode.input_data);
      expect(inputData.maxResults).toBe(15);
    });

    it('should prefix node IDs with job ID', () => {
      const template = getTemplate('inbox_assistant')!;
      const result = buildTaskGraph({
        template,
        slots: { maxResults: 20 },
        triggerType: 'channel_message',
        channel: 'telegram',
        chatId: 'user1',
      });

      for (const nodeId of result.nodeIds) {
        expect(nodeId).toContain(result.jobId);
      }
    });

    it('should resolve dependencies with prefixed IDs', () => {
      const template = getTemplate('inbox_assistant')!;
      const result = buildTaskGraph({
        template,
        slots: { maxResults: 20 },
        triggerType: 'channel_message',
        channel: 'telegram',
        chatId: 'user1',
      });

      const nodes = getNodesByJobId(result.jobId);
      const summarize = nodes.find(n => n.type === 'gmail.summarize')!;
      const deps: string[] = JSON.parse(summarize.dependencies);
      expect(deps).toHaveLength(1);
      expect(deps[0]).toBe(`${result.jobId}_gmail_list`);
    });

    it('should handle parallel template (email_calendar_combo)', () => {
      const template = getTemplate('email_calendar_combo')!;
      const result = buildTaskGraph({
        template,
        slots: { maxResults: 20 },
        triggerType: 'channel_message',
        channel: 'telegram',
        chatId: 'user1',
      });

      const nodes = getNodesByJobId(result.jobId);
      expect(nodes).toHaveLength(6);

      // gmail_list and calendar_list should have no dependencies (parallel roots)
      const gmailList = nodes.find(n => n.type === 'gmail.list')!;
      const calList = nodes.find(n => n.type === 'calendar.list')!;
      expect(JSON.parse(gmailList.dependencies)).toHaveLength(0);
      expect(JSON.parse(calList.dependencies)).toHaveLength(0);
    });
  });

  // === DAG VALIDATION ===
  describe('graphValidation', () => {
    it('should validate a valid DAG', () => {
      const jobId = makeJob();
      const nodes = createNodes([
        { jobId, id: 'n1', type: 'test.a', assignedAgent: 'WorkspaceAgent', model: 'fast', dependencies: [] },
        { jobId, id: 'n2', type: 'test.b', assignedAgent: 'WorkspaceAgent', model: 'fast', dependencies: ['n1'] },
        { jobId, id: 'n3', type: 'aggregate', assignedAgent: 'AggregatorAgent', model: 'fast', dependencies: ['n2'] },
      ]);
      const result = validateDAG(nodes);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect duplicate node IDs', () => {
      const jobId = makeJob();
      // Manually construct rows with duplicate IDs
      const node = createNode({ jobId, id: 'dup1', type: 'test.a', assignedAgent: 'W', model: 'fast', dependencies: [] });
      const fakeNodes = [node, { ...node }]; // same ID twice
      const result = validateDAG(fakeNodes);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Duplicate'))).toBe(true);
    });

    it('should detect unknown dependencies', () => {
      const jobId = makeJob();
      const nodes = createNodes([
        { jobId, id: 'v1', type: 'test.a', assignedAgent: 'W', model: 'fast', dependencies: ['nonexistent'] },
      ]);
      const result = validateDAG(nodes);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('unknown dependency'))).toBe(true);
    });

    it('should detect invalid model', () => {
      // Construct a fake NodeRow with invalid model (DB CHECK prevents inserting one)
      const fakeNode = {
        id: 'v2', job_id: 'j1', type: 'test.a', title: '', description: '', status: 'pending',
        assigned_agent: 'W', model: 'gpt-4', dependencies: '[]', input_data: '{}',
        output_data: null, artifact_ids: '[]', tool_permissions: '[]',
        requires_approval: 0, retry_count: 0, max_retries: 2, timeout_ms: 60000,
        token_budget: 10000, created_at: Date.now(), updated_at: Date.now(),
      } as any;
      const result = validateDAG([fakeNode]);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('invalid model'))).toBe(true);
    });
  });

  // === TOPOLOGICAL SORT ===
  describe('topologicalSort', () => {
    it('should sort a simple chain', () => {
      const jobId = makeJob();
      const nodes = createNodes([
        { jobId, id: 'a', type: 'test', assignedAgent: 'W', model: 'fast', dependencies: [] },
        { jobId, id: 'b', type: 'test', assignedAgent: 'W', model: 'fast', dependencies: ['a'] },
        { jobId, id: 'c', type: 'test', assignedAgent: 'W', model: 'fast', dependencies: ['b'] },
      ]);
      const sorted = topologicalSort(nodes);
      expect(sorted).toEqual(['a', 'b', 'c']);
    });

    it('should sort a diamond DAG', () => {
      const jobId = makeJob();
      const nodes = createNodes([
        { jobId, id: 'd1', type: 'test', assignedAgent: 'W', model: 'fast', dependencies: [] },
        { jobId, id: 'd2', type: 'test', assignedAgent: 'W', model: 'fast', dependencies: ['d1'] },
        { jobId, id: 'd3', type: 'test', assignedAgent: 'W', model: 'fast', dependencies: ['d1'] },
        { jobId, id: 'd4', type: 'test', assignedAgent: 'W', model: 'fast', dependencies: ['d2', 'd3'] },
      ]);
      const sorted = topologicalSort(nodes);
      expect(sorted[0]).toBe('d1');
      expect(sorted[sorted.length - 1]).toBe('d4');
      expect(sorted.indexOf('d2')).toBeGreaterThan(sorted.indexOf('d1'));
      expect(sorted.indexOf('d3')).toBeGreaterThan(sorted.indexOf('d1'));
    });

    it('should detect a cycle', () => {
      const jobId = makeJob();
      // We need to manually create nodes with circular deps
      // createNodes won't allow invalid FK deps, but the deps are just JSON strings
      const nodes = createNodes([
        { jobId, id: 'cyc1', type: 'test', assignedAgent: 'W', model: 'fast', dependencies: ['cyc2'] },
        { jobId, id: 'cyc2', type: 'test', assignedAgent: 'W', model: 'fast', dependencies: ['cyc1'] },
      ]);
      expect(() => topologicalSort(nodes)).toThrow('Cycle detected');
    });

    it('should report cycle via isAcyclic', () => {
      const jobId = makeJob();
      const nodes = createNodes([
        { jobId, id: 'ac1', type: 'test', assignedAgent: 'W', model: 'fast', dependencies: ['ac2'] },
        { jobId, id: 'ac2', type: 'test', assignedAgent: 'W', model: 'fast', dependencies: ['ac1'] },
      ]);
      expect(isAcyclic(nodes)).toBe(false);
    });

    it('should handle single node', () => {
      const jobId = makeJob();
      const nodes = createNodes([
        { jobId, id: 'solo', type: 'test', assignedAgent: 'W', model: 'fast', dependencies: [] },
      ]);
      expect(topologicalSort(nodes)).toEqual(['solo']);
    });
  });

  // === CIRCUIT BREAKERS ===
  describe('circuitBreakers', () => {
    it('should pass when all limits are fine', () => {
      const jobId = makeJob();
      const job = getJob(jobId)!;
      const result = checkCircuitBreakers(job);
      expect(result.ok).toBe(true);
    });

    it('should trip on too many LLM calls', () => {
      const jobId = makeJob();
      // Increment LLM calls to exceed limit (30)
      for (let i = 0; i < 30; i++) {
        incrementJobLLMCalls(jobId);
      }
      const job = getJob(jobId)!;
      const result = checkCircuitBreakers(job);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('max_llm_calls_exceeded');
    });

    it('should trip on daily budget exhaustion', () => {
      const jobId = makeJob();
      resetDailyBudget(Date.now());
      incrementDailyTokens(200000); // exhaust full budget
      const job = getJob(jobId)!;
      const result = checkCircuitBreakers(job, 1000);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('daily_budget_exhausted');
    });

    it('should pass daily budget check when window has elapsed', () => {
      const jobId = makeJob();
      // Set window start to >24h ago
      resetDailyBudget(Date.now() - 25 * 60 * 60 * 1000);
      incrementDailyTokens(200000);
      const job = getJob(jobId)!;
      const result = checkCircuitBreakers(job, 1000);
      // Window elapsed, so budget is effectively reset
      expect(result.ok).toBe(true);
    });

    it('should check daily budget only', () => {
      resetDailyBudget(Date.now());
      incrementDailyTokens(199000);
      const result = checkDailyBudget(5000);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('daily_budget_exhausted');
    });
  });

  // === APPROVAL HANDLER ===
  describe('approvalHandler', () => {
    it('should create approval and resolve on event', async () => {
      const jobId = makeJob();
      const node = createNode({
        jobId, type: 'gmail.send', title: 'Send email', assignedAgent: 'WorkspaceAgent', model: 'fast',
        dependencies: [], requiresApproval: true,
      });

      // Request approval (returns promise that resolves when event fires)
      const approvalPromise = requestApproval({
        nodeId: node.id,
        actionType: 'gmail.send',
        title: 'Send email to john@example.com',
        preview: 'Subject: Meeting\nBody: Let us meet...',
        payload: { to: 'john@example.com' },
      });

      // Verify node is now waiting_approval
      const updatedNode = getNode(node.id)!;
      expect(updatedNode.status).toBe('waiting_approval');

      // Resolve the approval
      resolveApproval(node.id, { approvalId: 'any', status: 'approved' });

      const resolution = await approvalPromise;
      expect(resolution.status).toBe('approved');
    });

    it('should handle rejection', async () => {
      const jobId = makeJob();
      const node = createNode({
        jobId, type: 'gmail.send', title: 'Send', assignedAgent: 'W', model: 'fast',
        dependencies: [], requiresApproval: true,
      });

      const promise = requestApproval({
        nodeId: node.id,
        actionType: 'send',
        title: 'test',
        preview: 'test',
        payload: {},
      });

      resolveApproval(node.id, { approvalId: 'a1', status: 'rejected' });

      const resolution = await promise;
      expect(resolution.status).toBe('rejected');
    });
  });

  // === RUN NODE ===
  describe('runNode', () => {
    it('should execute a node with worker and update status to completed', async () => {
      const jobId = makeJob();
      updateJobStatus(jobId, 'running');
      const node = createNode({
        jobId, type: 'test.action', title: 'Test Node', assignedAgent: 'TestAgent', model: 'fast', dependencies: [],
      });

      setWorkerExecutor(async () => ({
        output: { result: 'success' },
        costTokens: 100,
      }));

      await runNode(node.id);

      const updated = getNode(node.id)!;
      expect(updated.status).toBe('completed');
      expect(JSON.parse(updated.output_data!)).toEqual({ result: 'success' });
    });

    it('should retry on failure when retries available', async () => {
      const jobId = makeJob();
      updateJobStatus(jobId, 'running');
      const node = createNode({
        jobId, type: 'test.action', title: 'Test Node', assignedAgent: 'TestAgent', model: 'fast',
        dependencies: [], maxRetries: 2,
      });

      setWorkerExecutor(async () => {
        throw new Error('Worker failed');
      });

      await expect(runNode(node.id)).rejects.toThrow('Worker failed');

      const updated = getNode(node.id)!;
      // Should be set back to pending for retry (retry_count < max_retries)
      expect(updated.status).toBe('pending');
      expect(updated.retry_count).toBe(1);
    });

    it('should mark as failed when retries exhausted', async () => {
      const jobId = makeJob();
      updateJobStatus(jobId, 'running');
      const node = createNode({
        jobId, type: 'test.action', title: 'Test Node', assignedAgent: 'TestAgent', model: 'fast',
        dependencies: [], maxRetries: 0,
      });

      setWorkerExecutor(async () => {
        throw new Error('Fatal error');
      });

      await expect(runNode(node.id)).rejects.toThrow('Fatal error');

      const updated = getNode(node.id)!;
      expect(updated.status).toBe('failed');
    });

    it('should throw if no worker executor set', async () => {
      const jobId = makeJob();
      updateJobStatus(jobId, 'running');
      const node = createNode({
        jobId, type: 'test.action', title: 'Test', assignedAgent: 'W', model: 'fast', dependencies: [],
      });

      setWorkerExecutor(null as unknown as any);

      await expect(runNode(node.id)).rejects.toThrow('No worker executor configured');
    });

    it('should throw if node not found', async () => {
      await expect(runNode('nonexistent')).rejects.toThrow('Node not found');
    });
  });

  // === EXECUTE JOB ===
  describe('executeJob', () => {
    it('should execute a simple single-node job', async () => {
      const jobId = makeJob();
      const node = createNode({
        jobId, type: 'test.action', title: 'Only Node', assignedAgent: 'TestAgent', model: 'fast', dependencies: [],
      });

      setWorkerExecutor(async () => ({
        output: { done: true },
        costTokens: 50,
      }));

      await executeJob(jobId);

      // Wait for async event processing
      await new Promise(resolve => setTimeout(resolve, 100));

      const job = getJob(jobId)!;
      expect(job.status).toBe('completed');
    });

    it('should execute a chain of dependent nodes', async () => {
      const jobId = makeJob();
      createNodes([
        { jobId, id: `${jobId}_step1`, type: 'test.a', title: 'Step 1', assignedAgent: 'W', model: 'fast', dependencies: [] },
        { jobId, id: `${jobId}_step2`, type: 'test.b', title: 'Step 2', assignedAgent: 'W', model: 'fast', dependencies: [`${jobId}_step1`] },
      ]);

      const executionOrder: string[] = [];
      setWorkerExecutor(async (nodeId) => {
        executionOrder.push(nodeId);
        return { output: { ok: true }, costTokens: 25 };
      });

      await executeJob(jobId);
      await new Promise(resolve => setTimeout(resolve, 200));

      const job = getJob(jobId)!;
      expect(job.status).toBe('completed');
      expect(executionOrder).toEqual([`${jobId}_step1`, `${jobId}_step2`]);
    });

    it('should mark job failed if a node fails', async () => {
      const jobId = makeJob();
      createNode({
        jobId, type: 'test.failing', title: 'Failing', assignedAgent: 'W', model: 'fast', dependencies: [], maxRetries: 0,
      });

      setWorkerExecutor(async () => {
        throw new Error('Boom');
      });

      await executeJob(jobId);
      await new Promise(resolve => setTimeout(resolve, 100));

      const job = getJob(jobId)!;
      expect(job.status).toBe('failed');
    });

    it('should not execute if job not found', async () => {
      // Should return silently
      await executeJob('nonexistent-id');
    });

    it('should trip circuit breaker and fail job', async () => {
      const jobId = makeJob();
      createNode({
        jobId, type: 'test.a', title: 'A', assignedAgent: 'W', model: 'fast', dependencies: [],
      });

      // Exhaust LLM calls
      for (let i = 0; i < 30; i++) {
        incrementJobLLMCalls(jobId);
      }

      await executeJob(jobId);

      const job = getJob(jobId)!;
      expect(job.status).toBe('failed');
    });
  });
});

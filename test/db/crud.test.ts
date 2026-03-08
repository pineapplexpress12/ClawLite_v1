import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/schema.js';

// Mock connection.ts so CRUD modules use our in-memory DB
let testDb: Database.Database;

vi.mock('../../src/db/connection.js', () => ({
  getDb: () => testDb,
  getClawliteHome: () => '/tmp/clawlite-test',
}));

import { createJob, getJob, updateJobStatus, incrementJobLLMCalls, getJobsByStatus, getRecentJobs } from '../../src/db/jobs.js';
import { createNode, createNodes, getNode, getNodesByJobId, transitionNodeStatus, countNodes, countRunningNodes, resetRunningNodesToPending } from '../../src/db/nodes.js';
import { insertRun, completeRun, getRunsByNodeId } from '../../src/db/runs.js';
import { insertLedgerEntry, updateLedgerEntry, getRecentLedgerEntries } from '../../src/db/ledger.js';
import { insertMemory, getMemory, searchMemoryByTags, searchMemoryFts, countMemories, deleteMemory } from '../../src/db/memory.js';
import { insertSession, getRecentSessions, getTotalSessionTokens, clearSessions } from '../../src/db/sessions.js';
import { storeTextArtifact, storeFileArtifact, getArtifact, getArtifactsByJobId } from '../../src/db/artifacts.js';
import { createApproval, getApproval, getPendingApprovals, updateApprovalStatus } from '../../src/db/approvals.js';
import { createSubAgent, getSubAgent, getSubAgentByName, getActiveSubAgents, deleteSubAgent } from '../../src/db/subAgents.js';
import { getDailyBudget, resetDailyBudget, incrementDailyTokens } from '../../src/db/dailyBudget.js';

/** Helper: create a job and return its id */
function makeJob(goal = 'Test goal'): string {
  const job = createJob({ goal, triggerType: 'channel_message', channel: 'telegram', chatId: 'u1' });
  return job.id;
}

/** Helper: create a job + node and return both ids */
function makeJobAndNode(): { jobId: string; nodeId: string } {
  const jobId = makeJob();
  const node = createNode({
    jobId, type: 'test.action', title: 'Test', assignedAgent: 'WorkspaceAgent', model: 'fast', dependencies: [],
  });
  return { jobId, nodeId: node.id };
}

describe('CRUD operations', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');
    runMigrations(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  // --- Jobs ---
  describe('jobs', () => {
    it('should create and retrieve a job', () => {
      const job = createJob({
        goal: 'Check my inbox',
        triggerType: 'channel_message',
        chatId: 'user123',
        channel: 'telegram',
      });

      expect(job).toBeDefined();
      expect(job.goal).toBe('Check my inbox');
      expect(job.status).toBe('pending');
      expect(job.channel).toBe('telegram');

      const fetched = getJob(job.id);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(job.id);
    });

    it('should update job status', () => {
      const jobId = makeJob();

      updateJobStatus(jobId, 'running');
      expect(getJob(jobId)!.status).toBe('running');

      updateJobStatus(jobId, 'completed');
      expect(getJob(jobId)!.status).toBe('completed');
    });

    it('should increment LLM calls', () => {
      const jobId = makeJob();
      incrementJobLLMCalls(jobId);
      incrementJobLLMCalls(jobId);
      expect(getJob(jobId)!.total_llm_calls).toBe(2);
    });

    it('should filter by status', () => {
      makeJob();
      const jobId2 = makeJob('Second');
      updateJobStatus(jobId2, 'running');

      const pending = getJobsByStatus(['pending']);
      expect(pending).toHaveLength(1);
      const running = getJobsByStatus(['running']);
      expect(running).toHaveLength(1);
    });

    it('should get recent jobs', () => {
      for (let i = 0; i < 5; i++) {
        makeJob(`Job ${i}`);
      }
      const recent = getRecentJobs(3);
      expect(recent).toHaveLength(3);
    });
  });

  // --- Nodes ---
  describe('nodes', () => {
    it('should create and retrieve nodes', () => {
      const jobId = makeJob();
      const node = createNode({
        jobId,
        type: 'gmail.fetch',
        title: 'Fetch inbox',
        assignedAgent: 'WorkspaceAgent',
        model: 'fast',
        inputData: { limit: 10 },
        dependencies: [],
      });

      expect(node).toBeDefined();
      expect(node.type).toBe('gmail.fetch');
      expect(node.status).toBe('pending');

      const fetched = getNode(node.id);
      expect(fetched).toBeDefined();
    });

    it('should create batch nodes in transaction', () => {
      const jobId = makeJob();
      const nodes = createNodes([
        { jobId, type: 'a', title: 'A', assignedAgent: 'WorkspaceAgent', model: 'fast' },
        { jobId, type: 'b', title: 'B', assignedAgent: 'ResearchAgent', model: 'balanced' },
      ]);

      expect(nodes).toHaveLength(2);
      const all = getNodesByJobId(jobId);
      expect(all).toHaveLength(2);
    });

    it('should transition node status atomically', () => {
      const { nodeId } = makeJobAndNode();

      transitionNodeStatus(nodeId, 'running');
      expect(getNode(nodeId)!.status).toBe('running');

      transitionNodeStatus(nodeId, 'completed', { result: 'Done' });
      const node = getNode(nodeId);
      expect(node!.status).toBe('completed');
      expect(JSON.parse(node!.output_data!)).toEqual({ result: 'Done' });
    });

    it('should count nodes', () => {
      const jobId = makeJob();
      createNode({ jobId, type: 'a', title: 'A', assignedAgent: 'W', model: 'fast' });
      const n2 = createNode({ jobId, type: 'b', title: 'B', assignedAgent: 'W', model: 'fast' });
      transitionNodeStatus(n2.id, 'running');

      expect(countNodes(jobId)).toBe(2);
      expect(countRunningNodes(jobId)).toBe(1);
    });

    it('should reset running nodes to pending', () => {
      const { nodeId } = makeJobAndNode();
      transitionNodeStatus(nodeId, 'running');

      resetRunningNodesToPending();
      expect(getNode(nodeId)!.status).toBe('pending');
    });
  });

  // --- Runs ---
  describe('runs', () => {
    it('should insert and complete a run', () => {
      const { nodeId } = makeJobAndNode();

      const run = insertRun(nodeId);
      expect(run.status).toBe('running');

      completeRun(nodeId, 'completed', 150);

      const runs = getRunsByNodeId(nodeId);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe('completed');
      expect(runs[0]!.cost_tokens).toBe(150);
    });
  });

  // --- Ledger ---
  describe('ledger', () => {
    it('should insert and update ledger entries', () => {
      const id = insertLedgerEntry({
        agent: 'WorkspaceAgent',
        tool: 'gmail.send',
        action: 'send_email',
        params: { to: 'test@example.com' },
        status: 'started',
      });

      updateLedgerEntry(id, { status: 'success', result: { messageId: '123' } });

      const entries = getRecentLedgerEntries(10);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.status).toBe('success');
    });
  });

  // --- Memory ---
  describe('memory', () => {
    it('should insert and retrieve memory', () => {
      const id = insertMemory({
        type: 'semantic',
        content: 'User prefers dark mode',
        tags: ['preference', 'ui'],
        tokenCount: 10,
      });

      const mem = getMemory(id);
      expect(mem).toBeDefined();
      expect(mem!.content).toBe('User prefers dark mode');
      expect(JSON.parse(mem!.tags)).toEqual(['preference', 'ui']);
    });

    it('should search by tags', () => {
      insertMemory({ type: 'semantic', content: 'Fact 1', tags: ['alpha'], tokenCount: 5 });
      insertMemory({ type: 'semantic', content: 'Fact 2', tags: ['beta'], tokenCount: 5 });
      insertMemory({ type: 'semantic', content: 'Fact 3', tags: ['alpha', 'beta'], tokenCount: 5 });

      const results = searchMemoryByTags(['alpha'], 10);
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it('should search via FTS5', () => {
      insertMemory({ type: 'semantic', content: 'The user lives in San Francisco', tags: [], tokenCount: 15 });
      insertMemory({ type: 'semantic', content: 'The user works at Anthropic', tags: [], tokenCount: 12 });

      const results = searchMemoryFts('San Francisco', 10);
      expect(results).toHaveLength(1);
      expect(results[0]!.content).toContain('San Francisco');
    });

    it('should count and delete memories', () => {
      const id = insertMemory({ type: 'episodic', content: 'Test', tags: [], tokenCount: 3 });
      expect(countMemories()).toBe(1);

      deleteMemory(id);
      expect(countMemories()).toBe(0);
    });
  });

  // --- Sessions ---
  describe('sessions', () => {
    it('should insert and retrieve sessions in order', () => {
      insertSession({ chatId: 'c1', channel: 'telegram', role: 'user', content: 'Hello', tokenCount: 5 });
      insertSession({ chatId: 'c1', channel: 'telegram', role: 'assistant', content: 'Hi there', tokenCount: 8 });

      const sessions = getRecentSessions('c1', 'telegram', 10);
      expect(sessions).toHaveLength(2);
      expect(sessions[0]!.role).toBe('user');
      expect(sessions[1]!.role).toBe('assistant');
    });

    it('should count total tokens', () => {
      insertSession({ chatId: 'c1', channel: 'telegram', role: 'user', content: 'Hello', tokenCount: 100 });
      insertSession({ chatId: 'c1', channel: 'telegram', role: 'assistant', content: 'Hi', tokenCount: 50 });

      expect(getTotalSessionTokens('c1', 'telegram')).toBe(150);
    });

    it('should clear sessions', () => {
      insertSession({ chatId: 'c1', channel: 'telegram', role: 'user', content: 'Hello', tokenCount: 5 });
      clearSessions('c1', 'telegram');

      const sessions = getRecentSessions('c1', 'telegram', 10);
      expect(sessions).toHaveLength(0);
    });
  });

  // --- Artifacts ---
  describe('artifacts', () => {
    it('should store and retrieve text artifacts', () => {
      const jobId = makeJob();
      const id = storeTextArtifact({
        jobId,
        type: 'email_summary',
        title: 'Inbox Summary',
        content: '3 unread emails',
      });

      const art = getArtifact(id);
      expect(art).toBeDefined();
      expect(art!.content).toBe('3 unread emails');
      expect(art!.path).toBeNull();
    });

    it('should store file artifacts without FK', () => {
      const id = storeFileArtifact({
        type: 'attachment',
        title: 'doc.pdf',
        path: '/tmp/doc.pdf',
        mimeType: 'application/pdf',
        fileSize: 1024,
      });

      const art = getArtifact(id);
      expect(art).toBeDefined();
      expect(art!.path).toBe('/tmp/doc.pdf');
      expect(art!.mime_type).toBe('application/pdf');
    });

    it('should get artifacts by job ID', () => {
      const jobId = makeJob();
      storeTextArtifact({ jobId, type: 'a', title: 'A', content: 'a' });
      storeTextArtifact({ jobId, type: 'b', title: 'B', content: 'b' });

      const arts = getArtifactsByJobId(jobId);
      expect(arts).toHaveLength(2);
    });
  });

  // --- Approvals ---
  describe('approvals', () => {
    it('should create and retrieve approvals', () => {
      const { nodeId } = makeJobAndNode();
      const id = createApproval({
        nodeId,
        actionType: 'gmail.send',
        title: 'Send email',
        preview: 'To: test@example.com\nSubject: Hello',
        payload: { to: 'test@example.com' },
      });

      const approval = getApproval(id);
      expect(approval).toBeDefined();
      expect(approval!.status).toBe('pending');
    });

    it('should list pending approvals', () => {
      const { nodeId: n1 } = makeJobAndNode();
      const { nodeId: n2 } = makeJobAndNode();

      createApproval({ nodeId: n1, actionType: 'send', title: 'A', preview: 'x', payload: {} });
      const id2 = createApproval({ nodeId: n2, actionType: 'send', title: 'B', preview: 'y', payload: {} });
      updateApprovalStatus(id2, 'approved');

      const pending = getPendingApprovals();
      expect(pending).toHaveLength(1);
    });
  });

  // --- Sub-agents ---
  describe('subAgents', () => {
    it('should create and retrieve sub-agents', () => {
      const agent = createSubAgent({
        name: 'inbox',
        persona: 'You manage email.',
        tools: ['workspace.gmail'],
        templates: ['inbox_assistant'],
      });

      expect(agent.name).toBe('inbox');
      expect(agent.status).toBe('active');

      const found = getSubAgentByName('inbox');
      expect(found).toBeDefined();
      expect(found!.id).toBe(agent.id);
    });

    it('should list active agents', () => {
      createSubAgent({ name: 'a1', persona: 'p', tools: [], templates: [] });
      createSubAgent({ name: 'a2', persona: 'p', tools: [], templates: [] });

      const active = getActiveSubAgents();
      expect(active).toHaveLength(2);
    });

    it('should delete sub-agents', () => {
      const agent = createSubAgent({ name: 'temp', persona: 'p', tools: [], templates: [] });
      deleteSubAgent(agent.id);

      expect(getSubAgent(agent.id)).toBeUndefined();
    });
  });

  // --- Daily Budget ---
  describe('dailyBudget', () => {
    it('should get seeded budget row', () => {
      const budget = getDailyBudget();
      expect(budget.id).toBe(1);
      expect(budget.tokens_consumed).toBe(0);
    });

    it('should increment tokens', () => {
      incrementDailyTokens(1000);
      incrementDailyTokens(500);
      expect(getDailyBudget().tokens_consumed).toBe(1500);
    });

    it('should reset budget', () => {
      incrementDailyTokens(5000);
      const newStart = Date.now();
      resetDailyBudget(newStart);

      const budget = getDailyBudget();
      expect(budget.tokens_consumed).toBe(0);
      expect(budget.window_start).toBe(newStart);
    });
  });
});

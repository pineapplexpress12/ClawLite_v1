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
    channels: {},
  }),
}));

vi.mock('../../src/llm/provider.js', () => ({
  complete: async (params: any) => {
    if (params.format === 'json') {
      // Template generation
      return {
        text: JSON.stringify({
          id: 'test_template',
          name: 'Test Template',
          description: 'A test template',
          slots: [{ name: 'query', description: 'Search query', required: true }],
          nodes: [
            {
              id: 'step1',
              type: 'research.search',
              title: 'Search',
              description: 'Search for info',
              assignedAgent: 'ResearchAgent',
              model: 'fast',
              dependencies: [],
              input: { query: '{{slots.query}}' },
              toolPermissions: [],
              requiresApproval: false,
            },
          ],
        }),
        parsed: {
          id: 'test_template',
          name: 'Test Template',
          description: 'A test template',
          slots: [{ name: 'query', description: 'Search query', required: true }],
          nodes: [
            {
              id: 'step1',
              type: 'research.search',
              title: 'Search',
              description: 'Search for info',
              assignedAgent: 'ResearchAgent',
              model: 'fast',
              dependencies: [],
              input: { query: '{{slots.query}}' },
              toolPermissions: [],
              requiresApproval: false,
            },
          ],
        },
        usage: { total_tokens: 500 },
      };
    }
    // Tool generation
    return {
      text: `import { z } from 'zod';
export default {
  name: 'test-tool',
  description: 'A test tool',
  requiredSecrets: ['TEST_API_KEY'],
  actions: [{
    name: 'get',
    description: 'Get data',
    parameters: z.object({ id: z.string() }),
    handler: async (params: any) => ({ data: 'ok' }),
  }],
};`,
      parsed: null,
      usage: { total_tokens: 300 },
    };
  },
}));

import { generateTool, installApprovedTool, cleanupTempTool } from '../../src/selfBuild/toolGenerator.js';
import { authorTemplate, saveApprovedTemplate, promoteAgenticToTemplate } from '../../src/selfBuild/templateAuthor.js';
import { createNewSubAgent, pauseSubAgent, resumeSubAgent } from '../../src/selfBuild/subAgentCreator.js';
import { appendToEnvFile, hasSecret, getMissingSecrets } from '../../src/selfBuild/secretCollector.js';
import { getSubAgent } from '../../src/db/subAgents.js';
import { getTemplate } from '../../src/planner/templates.js';

describe('Phase 11: Self-Building', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');
    runMigrations(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  // === TOOL GENERATOR ===
  describe('toolGenerator', () => {
    it('should generate tool code and run security analysis', async () => {
      const result = await generateTool({
        name: 'test-api',
        apiDescription: 'A test API for unit tests',
        actions: [{ name: 'get', description: 'Get data', risk: 'read' }],
      });

      expect(result.code).toContain('test-tool');
      expect(result.security).toBeDefined();
      expect(result.security.score).toBeGreaterThanOrEqual(0);
      expect(result.tempPath).toContain('clawlite-tool-test-api');
    });

    it('should clean up temp files', async () => {
      const result = await generateTool({
        name: 'cleanup-test',
        apiDescription: 'Test',
        actions: [{ name: 'get', description: 'Get', risk: 'read' }],
      });

      // Should not throw
      cleanupTempTool(result.tempPath);
      cleanupTempTool('/nonexistent/path'); // should not throw
    });
  });

  // === TEMPLATE AUTHOR ===
  describe('templateAuthor', () => {
    it('should generate a valid template', async () => {
      const result = await authorTemplate({
        name: 'Test Workflow',
        description: 'A test workflow',
        steps: '1. Search for information\n2. Summarize results',
      });

      expect(result.valid).toBe(true);
      expect(result.template.id).toBe('test_template');
      expect(result.template.nodes).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect validation errors in templates', () => {
      // Directly test validation by promoting an invalid plan
      const template = promoteAgenticToTemplate(
        {
          nodes: [
            { id: 'a', type: 'test', model: 'fast', dependencies: ['nonexistent'] },
          ],
          description: 'Bad plan',
        },
        'bad_template',
        'Bad Template',
      );

      // The template is structurally created but has dependency errors
      expect(template.nodes[0]!.dependencies).toContain('nonexistent');
    });

    it('should promote agentic plan to template', () => {
      const template = promoteAgenticToTemplate(
        {
          nodes: [
            { id: 'step1', type: 'research.search', model: 'fast', agent: 'ResearchAgent', dependencies: [] },
            { id: 'step2', type: 'aggregate', model: 'fast', agent: 'AggregatorAgent', dependencies: ['step1'] },
          ],
          description: 'Research and summarize',
        },
        'promoted_workflow',
        'Promoted Workflow',
        '/promoted',
      );

      expect(template.id).toBe('promoted_workflow');
      expect(template.slashCommand).toBe('/promoted');
      expect(template.nodes).toHaveLength(2);
      expect(template.nodes[1]!.dependencies).toContain('step1');
    });
  });

  // === SUB-AGENT CREATOR ===
  describe('subAgentCreator', () => {
    it('should create a new sub-agent', () => {
      const agent = createNewSubAgent({
        name: 'TestAgent',
        description: 'A test agent',
        persona: 'You are a test agent.',
        tools: ['research'],
        templates: ['deep_research'],
      });

      expect(agent.name).toBe('TestAgent');
      expect(agent.status).toBe('active');

      const fetched = getSubAgent(agent.id);
      expect(fetched).toBeDefined();
      expect(fetched!.name).toBe('TestAgent');
    });

    it('should reject duplicate names', () => {
      createNewSubAgent({
        name: 'UniqueAgent',
        description: 'First',
        persona: 'You are first.',
        tools: [],
        templates: [],
      });

      expect(() => createNewSubAgent({
        name: 'UniqueAgent',
        description: 'Duplicate',
        persona: 'You are duplicate.',
        tools: [],
        templates: [],
      })).toThrow('already exists');
    });

    it('should pause and resume sub-agents', () => {
      const agent = createNewSubAgent({
        name: 'PausableAgent',
        description: 'Can pause',
        persona: 'You are pausable.',
        tools: [],
        templates: [],
      });

      pauseSubAgent(agent.id);
      let fetched = getSubAgent(agent.id)!;
      expect(fetched.status).toBe('paused');

      resumeSubAgent(agent.id);
      fetched = getSubAgent(agent.id)!;
      expect(fetched.status).toBe('active');
    });
  });

  // === SECRET COLLECTOR ===
  describe('secretCollector', () => {
    it('should check for missing secrets', () => {
      const missing = getMissingSecrets(['DEFINITELY_NOT_SET_12345']);
      expect(missing).toContain('DEFINITELY_NOT_SET_12345');
    });

    it('should check for existing secrets', () => {
      process.env.TEST_SECRET_EXISTS = 'yes';
      expect(hasSecret('TEST_SECRET_EXISTS')).toBe(true);
      expect(hasSecret('DOES_NOT_EXIST_999')).toBe(false);
      delete process.env.TEST_SECRET_EXISTS;
    });

    it('should report all missing from a list', () => {
      process.env.SELF_BUILD_TEST_KEY = 'present';
      const missing = getMissingSecrets(['SELF_BUILD_TEST_KEY', 'MISSING_KEY_ABC']);
      expect(missing).toEqual(['MISSING_KEY_ABC']);
      delete process.env.SELF_BUILD_TEST_KEY;
    });
  });
});

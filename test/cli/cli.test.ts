import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/schema.js';
import { Command } from 'commander';

let testDb: Database.Database;

vi.mock('../../src/db/connection.js', () => ({
  getDb: () => testDb,
  getClawliteHome: () => '/tmp/clawlite-test',
  initDb: () => testDb,
}));

vi.mock('../../src/core/config.js', () => ({
  getConfig: () => ({
    operator: { name: 'TestBot' },
    llm: { provider: 'openrouter', tiers: { fast: 'gpt-4o-mini', balanced: 'gpt-4o', strong: 'claude-opus' } },
    budgets: { dailyTokens: 200000, perJobTokens: 50000, maxToolCallsPerJob: 200 },
    hardLimits: { maxNodesPerJob: 20, maxTotalLLMCalls: 30, maxJobDurationMs: 300000, maxRetriesTotalPerJob: 10 },
    channels: {},
    http: { enabled: true, port: 18790, host: '127.0.0.1' },
    heartbeat: { enabled: false, intervalMinutes: 30 },
    session: { turnsInjectedIntoChat: 5, maxTurnsInMemory: 20, compactionThresholdTokens: 8000 },
  }),
  loadConfig: () => {},
  ClawLiteConfigSchema: { safeParse: (d: any) => ({ success: true, data: d }) },
}));

import { registerStartCommand } from '../../src/cli/daemon.js';
import { registerSetupCommand } from '../../src/cli/setup.js';
import { registerTemplateCommands } from '../../src/cli/templates.js';
import { registerBudgetCommand } from '../../src/cli/budget.js';
import { registerJobCommands } from '../../src/cli/jobs.js';
import { registerResetCommands } from '../../src/cli/reset.js';
import { registerDbCommands } from '../../src/cli/db.js';
import { registerToolCommands } from '../../src/cli/tools.js';
import { registerMemoryCommands } from '../../src/cli/memory.js';
import { registerAgentCommands } from '../../src/cli/agents.js';

describe('Phase 12: CLI', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');
    runMigrations(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  // === COMMAND REGISTRATION ===
  describe('command registration', () => {
    it('should register start command', () => {
      const program = new Command();
      registerStartCommand(program);
      const cmd = program.commands.find(c => c.name() === 'start');
      expect(cmd).toBeDefined();
    });

    it('should register setup command', () => {
      const program = new Command();
      registerSetupCommand(program);
      const cmd = program.commands.find(c => c.name() === 'setup');
      expect(cmd).toBeDefined();
    });

    it('should register stop and restart commands', () => {
      const program = new Command();
      registerStartCommand(program);
      expect(program.commands.find(c => c.name() === 'stop')).toBeDefined();
      expect(program.commands.find(c => c.name() === 'restart')).toBeDefined();
    });

    it('should register templates command', () => {
      const program = new Command();
      registerTemplateCommands(program);
      expect(program.commands.find(c => c.name() === 'templates')).toBeDefined();
      expect(program.commands.find(c => c.name() === 'template')).toBeDefined();
    });

    it('should register budget command', () => {
      const program = new Command();
      registerBudgetCommand(program);
      expect(program.commands.find(c => c.name() === 'budget')).toBeDefined();
    });

    it('should register job commands', () => {
      const program = new Command();
      registerJobCommands(program);
      expect(program.commands.find(c => c.name() === 'jobs')).toBeDefined();
      expect(program.commands.find(c => c.name() === 'job')).toBeDefined();
    });

    it('should register reset command', () => {
      const program = new Command();
      registerResetCommands(program);
      expect(program.commands.find(c => c.name() === 'reset')).toBeDefined();
    });

    it('should register db commands', () => {
      const program = new Command();
      registerDbCommands(program);
      const dbCmd = program.commands.find(c => c.name() === 'db');
      expect(dbCmd).toBeDefined();
    });

    it('should register tool commands', () => {
      const program = new Command();
      registerToolCommands(program);
      const toolCmd = program.commands.find(c => c.name() === 'tool');
      expect(toolCmd).toBeDefined();
    });

    it('should register memory commands', () => {
      const program = new Command();
      registerMemoryCommands(program);
      const memCmd = program.commands.find(c => c.name() === 'memory');
      expect(memCmd).toBeDefined();
    });

    it('should register agents commands', () => {
      const program = new Command();
      registerAgentCommands(program);
      const agentsCmd = program.commands.find(c => c.name() === 'agents');
      expect(agentsCmd).toBeDefined();
    });
  });

  // === FULL CLI PROGRAM ===
  describe('full CLI program', () => {
    it('should assemble all commands without errors', async () => {
      const { registerSendCommand } = await import('../../src/cli/send.js');
      const { registerDryrunCommand } = await import('../../src/cli/dryrun.js');
      const { registerConfigCommands } = await import('../../src/cli/config.js');
      const { registerLogCommands } = await import('../../src/cli/logs.js');

      const program = new Command();
      program.name('clawlite').version('1.0.0');

      registerSetupCommand(program);
      registerStartCommand(program);
      registerConfigCommands(program);
      registerLogCommands(program);
      registerJobCommands(program);
      registerBudgetCommand(program);
      registerMemoryCommands(program);
      registerAgentCommands(program);
      registerToolCommands(program);
      registerTemplateCommands(program);
      registerResetCommands(program);
      registerDbCommands(program);
      registerSendCommand(program);
      registerDryrunCommand(program);

      // Should have all top-level commands
      const names = program.commands.map(c => c.name());
      expect(names).toContain('setup');
      expect(names).toContain('start');
      expect(names).toContain('stop');
      expect(names).toContain('restart');
      expect(names).toContain('config');
      expect(names).toContain('logs');
      expect(names).toContain('jobs');
      expect(names).toContain('job');
      expect(names).toContain('budget');
      expect(names).toContain('memory');
      expect(names).toContain('agents');
      expect(names).toContain('tool');
      expect(names).toContain('templates');
      expect(names).toContain('template');
      expect(names).toContain('reset');
      expect(names).toContain('db');
      expect(names).toContain('send');
      expect(names).toContain('dryrun');
    });
  });
});

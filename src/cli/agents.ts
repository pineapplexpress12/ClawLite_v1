import type { Command } from 'commander';

/**
 * Register sub-agent listing and management commands.
 */
export function registerAgentCommands(program: Command): void {
  const agents = program
    .command('agents')
    .description('Sub-agent management');

  agents
    .command('list')
    .description('List all sub-agents')
    .action(async () => {
      const { loadConfig } = await import('../core/config.js');
      const { initDb } = await import('../db/connection.js');
      loadConfig();
      initDb();

      const { getAllSubAgents } = await import('../db/subAgents.js');
      const list = getAllSubAgents();

      if (list.length === 0) {
        console.log('No sub-agents found.');
        return;
      }

      console.log('Name              Status    Tier      Budget     Tools');
      console.log('-'.repeat(70));
      for (const agent of list) {
        const tools = JSON.parse(agent.tools) as string[];
        console.log(
          `${agent.name.padEnd(17)} ${agent.status.padEnd(9)} ${agent.default_tier.padEnd(9)} ${String(agent.budget_daily).padEnd(10)} ${tools.join(', ')}`
        );
      }
    });

  agents
    .command('info <name>')
    .description('Show sub-agent detail')
    .action(async (name: string) => {
      const { loadConfig } = await import('../core/config.js');
      const { initDb } = await import('../db/connection.js');
      loadConfig();
      initDb();

      const { getSubAgentByName } = await import('../db/subAgents.js');
      const agent = getSubAgentByName(name);

      if (!agent) {
        console.error(`Sub-agent "${name}" not found.`);
        process.exit(1);
      }

      console.log(`Sub-agent: ${agent.name}`);
      console.log(`  ID:          ${agent.id}`);
      console.log(`  Status:      ${agent.status}`);
      console.log(`  Description: ${agent.description ?? 'none'}`);
      console.log(`  Tier:        ${agent.default_tier}`);
      console.log(`  Budget:      ${agent.budget_daily} tokens/day`);
      console.log(`  Tools:       ${agent.tools}`);
      console.log(`  Templates:   ${agent.templates}`);
      console.log(`  Created:     ${new Date(agent.created_at).toISOString()}`);
    });

  agents
    .command('pause <name>')
    .description('Pause a sub-agent')
    .action(async (name: string) => {
      const { loadConfig } = await import('../core/config.js');
      const { initDb } = await import('../db/connection.js');
      loadConfig();
      initDb();

      const { getSubAgentByName } = await import('../db/subAgents.js');
      const { pauseSubAgent } = await import('../selfBuild/subAgentCreator.js');

      const agent = getSubAgentByName(name);
      if (!agent) { console.error(`Not found: ${name}`); process.exit(1); }
      pauseSubAgent(agent.id);
      console.log(`\u2713 ${name} paused.`);
    });

  agents
    .command('resume <name>')
    .description('Resume a paused sub-agent')
    .action(async (name: string) => {
      const { loadConfig } = await import('../core/config.js');
      const { initDb } = await import('../db/connection.js');
      loadConfig();
      initDb();

      const { getSubAgentByName } = await import('../db/subAgents.js');
      const { resumeSubAgent } = await import('../selfBuild/subAgentCreator.js');

      const agent = getSubAgentByName(name);
      if (!agent) { console.error(`Not found: ${name}`); process.exit(1); }
      resumeSubAgent(agent.id);
      console.log(`\u2713 ${name} resumed.`);
    });
}

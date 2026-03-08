import { getRecentJobs, getJob } from '../../db/jobs.js';
import { getNodesByJobId } from '../../db/nodes.js';
import { getDailyBudget } from '../../db/dailyBudget.js';
import { getActiveSubAgents } from '../../db/subAgents.js';
import { listTools } from '../../tools/sdk/registry.js';
import { getAllTemplates } from '../../planner/templates.js';
import { getConfig } from '../../core/config.js';
import type { CommandContext } from './commands.js';

/**
 * Handle system commands: /status, /budget, /jobs, /agents, /tools, /templates
 * Returns true if handled.
 */
export async function handleSystemCommand(
  command: string,
  args: string,
  ctx: CommandContext,
): Promise<boolean> {
  switch (command) {
    case '/status': {
      const config = getConfig();
      const budget = getDailyBudget();
      const jobs = getRecentJobs(5);
      const agents = getActiveSubAgents();
      const remaining = config.budgets.dailyTokens - budget.tokens_consumed;

      await ctx.sendMessage(
        `*Status*\nBudget: ${remaining.toLocaleString()} tokens remaining\nActive agents: ${agents.length}\nRecent jobs: ${jobs.length}`,
      );
      return true;
    }

    case '/budget': {
      const config = getConfig();
      const budget = getDailyBudget();
      const remaining = config.budgets.dailyTokens - budget.tokens_consumed;
      const pct = Math.round((budget.tokens_consumed / config.budgets.dailyTokens) * 100);

      await ctx.sendMessage(
        `*Budget*\nUsed: ${budget.tokens_consumed.toLocaleString()} / ${config.budgets.dailyTokens.toLocaleString()} (${pct}%)\nRemaining: ${remaining.toLocaleString()} tokens`,
      );
      return true;
    }

    case '/jobs': {
      const jobs = getRecentJobs(10);
      if (jobs.length === 0) {
        await ctx.sendMessage('No recent jobs.');
        return true;
      }
      const lines = jobs.map(j =>
        `- [${j.status}] ${j.goal.slice(0, 40)} (${j.id.slice(0, 8)})`,
      );
      await ctx.sendMessage(`*Recent Jobs*\n${lines.join('\n')}`);
      return true;
    }

    case '/job': {
      if (!args) {
        await ctx.sendMessage('Usage: /job <jobId>');
        return true;
      }
      const job = getJob(args);
      if (!job) {
        await ctx.sendMessage(`Job not found: ${args}`);
        return true;
      }
      const nodes = getNodesByJobId(job.id);
      const nodeLines = nodes.map(n => `  - [${n.status}] ${n.title} (${n.assigned_agent})`);
      await ctx.sendMessage(
        `*Job: ${job.id.slice(0, 8)}*\nGoal: ${job.goal}\nStatus: ${job.status}\nType: ${job.job_type}\nNodes:\n${nodeLines.join('\n')}`,
      );
      return true;
    }

    case '/agents': {
      const agents = getActiveSubAgents();
      if (agents.length === 0) {
        await ctx.sendMessage('No active sub-agents.');
        return true;
      }
      const lines = agents.map(a => `- ${a.name}: ${a.description} [${a.status}]`);
      await ctx.sendMessage(`*Sub-Agents*\n${lines.join('\n')}`);
      return true;
    }

    case '/tools': {
      const tools = listTools();
      if (tools.length === 0) {
        await ctx.sendMessage('No tools registered.');
        return true;
      }
      const lines = tools.map(t => `- ${t.name} v${t.version} [${t.risk}]`);
      await ctx.sendMessage(`*Tools*\n${lines.join('\n')}`);
      return true;
    }

    case '/templates': {
      const templates = getAllTemplates();
      const lines = templates.map(t =>
        `- ${t.slashCommand ?? t.id}: ${t.name} — ${t.description}`,
      );
      await ctx.sendMessage(`*Templates*\n${lines.join('\n')}`);
      return true;
    }

    default:
      return false;
  }
}

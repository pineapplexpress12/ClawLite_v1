import { existsSync } from 'node:fs';
import { getRecentJobs, getJob, getJobsByStatus } from '../../db/jobs.js';
import { getNodesByJobId } from '../../db/nodes.js';
import { getDailyBudget } from '../../db/dailyBudget.js';
import { getActiveSubAgents } from '../../db/subAgents.js';
import { listTools, getAllTools } from '../../tools/sdk/registry.js';
import { getAllTemplates } from '../../planner/templates.js';
import { getConfig } from '../../core/config.js';
import { getSecret, isGwsReady } from '../../core/secrets.js';
import { isHeartbeatRunning } from '../../heartbeat/scheduler.js';
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
      const dailyLimit = config.budgets?.dailyTokens ?? 200000;
      const remaining = dailyLimit - budget.tokens_consumed;
      const pct = Math.round((budget.tokens_consumed / dailyLimit) * 100);
      const agents = getActiveSubAgents();
      const tools = getAllTools();
      const activeJobs = getJobsByStatus(['running', 'waiting_approval']);
      const recentJobs = getRecentJobs(5);

      const gwsConnected = isGwsReady();

      const operatorName = config.operator?.name ?? 'ClawLite';
      const provider = config.llm?.provider ?? 'unknown';
      const fast = config.llm?.tiers?.fast ?? '?';
      const balanced = config.llm?.tiers?.balanced ?? '?';

      const lines: string[] = [
        `**Status**`,
        ``,
        `**Operator:** ${operatorName}`,
        `**Provider:** ${provider}`,
        `**Models:** fast=${fast}, balanced=${balanced}`,
        `**GWS:** ${gwsConnected ? 'Connected' : 'Not connected'}`,
        ``,
        `**Budget:** ${budget.tokens_consumed.toLocaleString()} / ${dailyLimit.toLocaleString()} tokens (${pct}%)`,
        `**Remaining:** ${remaining.toLocaleString()} tokens`,
        ``,
        `**Active jobs:** ${activeJobs.length}`,
        `**Sub-agents:** ${agents.length} (${agents.map(a => a.name).join(', ')})`,
        `**Tools:** ${tools.length} (${tools.map(t => t.name).join(', ')})`,
        `**Heartbeat:** ${isHeartbeatRunning() ? `Running (every ${config.heartbeat?.intervalMinutes ?? 30}m)` : 'Stopped'}`,
      ];

      if (recentJobs.length > 0) {
        lines.push('', '**Recent jobs:**');
        for (const j of recentJobs) {
          const icon = j.status === 'completed' ? '\u2705' : j.status === 'running' ? '\u2699\uFE0F' :
                       j.status === 'failed' ? '\u274C' : j.status === 'waiting_approval' ? '\u23F3' : '\u2022';
          lines.push(`${icon} ${j.goal.slice(0, 50)} (${j.status})`);
        }
      }

      await ctx.sendMessage(lines.join('\n'));
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
      const toolList = listTools();
      if (toolList.length === 0) {
        await ctx.sendMessage('No tools registered.');
        return true;
      }
      const toolLines = toolList.map(t => `- ${t.name} [${t.risk}]: ${t.description}`);
      await ctx.sendMessage(`**Tools**\n${toolLines.join('\n')}`);
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

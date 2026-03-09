import type { FastifyInstance } from 'fastify';
import { getConfig } from '../core/config.js';
import { getJobsByStatus, getRecentJobs } from '../db/jobs.js';
import { getDailyBudget } from '../db/dailyBudget.js';
import { countMemories } from '../db/memory.js';
import { getEnabledChannels } from '../channels/registry.js';
import { getAllSubAgents } from '../db/subAgents.js';
import { listTools } from '../tools/sdk/registry.js';
import { isHeartbeatRunning } from '../heartbeat/scheduler.js';

/**
 * Build the full system status object (shared by HTTP and WebSocket).
 */
export function getSystemStatus() {
  const config = getConfig();
  const budget = getDailyBudget();
  const activeJobs = getJobsByStatus(['running', 'waiting_approval']);
  const recent = getRecentJobs(10);
  const channels = getEnabledChannels();
  const agents = getAllSubAgents();
  const tools = listTools();

  return {
    uptime: process.uptime(),
    operator: config.operator.name,
    channels: channels.map(ch => ch.name),
    activeJobs: activeJobs.length,
    dailyBudget: {
      consumed: budget.tokens_consumed,
      limit: config.budgets.dailyTokens,
      remaining: config.budgets.dailyTokens - budget.tokens_consumed,
    },
    memoryItems: countMemories(),
    recentJobs: recent.map(j => ({
      id: j.id,
      goal: j.goal,
      status: j.status,
      triggerType: j.trigger_type,
      createdAt: j.created_at,
    })),
    subAgents: agents.map(a => ({
      name: a.name,
      status: a.status,
      tier: a.default_tier,
      description: a.description,
    })),
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      risk: t.risk,
    })),
    heartbeat: {
      enabled: config.heartbeat?.enabled ?? false,
      running: isHeartbeatRunning(),
      intervalMinutes: config.heartbeat?.intervalMinutes ?? 30,
      next: isHeartbeatRunning()
        ? `${config.heartbeat?.intervalMinutes ?? 30}m`
        : 'disabled',
      last: null,
    },
  };
}

/**
 * Register status API routes.
 * GET /status — returns system state as JSON.
 */
export function registerStatusRoutes(fastify: FastifyInstance): void {
  fastify.get('/status', async (_req, reply) => {
    return reply.send(getSystemStatus());
  });
}

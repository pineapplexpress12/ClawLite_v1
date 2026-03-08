import type { FastifyInstance } from 'fastify';
import { getConfig } from '../core/config.js';
import { getJobsByStatus, getRecentJobs } from '../db/jobs.js';
import { getDailyBudget } from '../db/dailyBudget.js';
import { countMemories } from '../db/memory.js';
import { getEnabledChannels } from '../channels/registry.js';

/**
 * Register status API routes.
 * GET /status — returns system state as JSON.
 */
export function registerStatusRoutes(fastify: FastifyInstance): void {
  fastify.get('/status', async (_req, reply) => {
    const config = getConfig();
    const budget = getDailyBudget();
    const activeJobs = getJobsByStatus(['running', 'waiting_approval']);
    const recent = getRecentJobs(5);
    const channels = getEnabledChannels();

    return reply.send({
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
    });
  });
}

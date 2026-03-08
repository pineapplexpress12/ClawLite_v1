import type { FastifyInstance } from 'fastify';
import { getConfig } from '../core/config.js';
import { getTemplate } from '../planner/templates.js';
import { buildTaskGraph } from '../planner/buildTaskGraph.js';
import { executeJob } from '../executor/executeJob.js';
import { logger } from '../core/logger.js';

/**
 * Register webhook routes.
 * POST /hooks/:templateId?token=SECRET
 * Triggers a template graph from external systems.
 */
export function registerWebhookRoutes(fastify: FastifyInstance): void {
  fastify.post<{
    Params: { templateId: string };
    Querystring: { token?: string };
    Body: { slots?: Record<string, unknown>; agentProfile?: string };
  }>('/hooks/:templateId', async (req, reply) => {
    const config = getConfig();
    const webhookToken = (config as any).http?.webhookToken;

    // Auth check
    if (webhookToken && req.query.token !== webhookToken) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const template = getTemplate(req.params.templateId);
    if (!template) {
      return reply.status(404).send({ error: 'template_not_found' });
    }

    const slots = req.body?.slots ?? {};
    const channel = 'webhook';
    const chatId = 'webhook';

    try {
      const { jobId } = buildTaskGraph({
        template,
        slots,
        triggerType: 'webhook',
        channel,
        chatId,
        dryRun: false,
      });

      // Fire and forget execution
      executeJob(jobId).catch(err => {
        logger.error('Webhook job execution failed', { jobId, error: (err as Error).message });
      });

      return reply.send({ jobId, status: 'started' });
    } catch (err) {
      logger.error('Webhook job creation failed', { error: (err as Error).message });
      return reply.status(400).send({ error: (err as Error).message });
    }
  });
}

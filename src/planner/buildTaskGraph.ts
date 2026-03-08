import { createJob } from '../db/jobs.js';
import { createNodes } from '../db/nodes.js';
import type { GraphTemplate } from './templates.js';

export interface BuildGraphParams {
  template: GraphTemplate;
  slots: Record<string, unknown>;
  triggerType: string;
  channel: string;
  chatId: string;
  dryRun?: boolean;
}

/**
 * Instantiate a template into a job + nodes in SQLite.
 */
export function buildTaskGraph(params: BuildGraphParams): { jobId: string; nodeIds: string[] } {
  const { template, slots, triggerType, channel, chatId, dryRun } = params;

  // Create job
  const job = createJob({
    goal: template.description,
    triggerType,
    channel,
    chatId,
    jobType: 'template',
    dryRun: dryRun ?? false,
  });

  // Resolve slot references in node inputs
  const nodes = template.nodes.map(nodeDef => ({
    jobId: job.id,
    id: `${job.id}_${nodeDef.id}`,
    type: nodeDef.type,
    title: nodeDef.title,
    description: nodeDef.description,
    assignedAgent: nodeDef.assignedAgent,
    model: nodeDef.model,
    dependencies: nodeDef.dependencies.map(d => `${job.id}_${d}`),
    inputData: resolveSlots(nodeDef.input, slots),
    toolPermissions: nodeDef.toolPermissions,
    requiresApproval: nodeDef.requiresApproval,
  }));

  const created = createNodes(nodes);
  return { jobId: job.id, nodeIds: created.map(n => n.id) };
}

/**
 * Replace {{slots.xxx}} placeholders in node input with actual slot values.
 */
function resolveSlots(
  input: Record<string, unknown>,
  slots: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.startsWith('{{slots.') && value.endsWith('}}')) {
      const slotName = value.slice(8, -2);
      resolved[key] = slots[slotName] ?? null;
    } else {
      resolved[key] = value;
    }
  }

  return resolved;
}

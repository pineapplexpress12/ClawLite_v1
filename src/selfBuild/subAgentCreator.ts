import { createSubAgent, getSubAgentByName, updateSubAgentStatus } from '../db/subAgents.js';
import type { SubAgentRow, CreateSubAgentParams } from '../db/subAgents.js';
import { logger } from '../core/logger.js';

export interface CreateSubAgentRequest {
  name: string;
  description: string;
  persona: string;
  tools: string[];
  templates: string[];
  defaultTier?: string;
  budgetTokensDaily?: number;
  cronJobs?: unknown[];
  heartbeatConditions?: string[];
}

/**
 * Create a new sub-agent from a request.
 * Validates that referenced tools and templates exist conceptually.
 * Returns the created sub-agent row.
 */
export function createNewSubAgent(request: CreateSubAgentRequest): SubAgentRow {
  // Check for name collision
  const existing = getSubAgentByName(request.name);
  if (existing) {
    throw new Error(`Sub-agent "${request.name}" already exists`);
  }

  const params: CreateSubAgentParams = {
    name: request.name,
    description: request.description,
    persona: request.persona,
    tools: request.tools,
    templates: request.templates,
    defaultTier: request.defaultTier ?? 'fast',
    budgetDaily: request.budgetTokensDaily ?? 50000,
    cronJobs: request.cronJobs,
    heartbeatConditions: request.heartbeatConditions,
    createdBy: 'operator',
  };

  const subAgent = createSubAgent(params);
  logger.info('Sub-agent created', { id: subAgent.id, name: subAgent.name });
  return subAgent;
}

/**
 * Pause a sub-agent (stops scheduled jobs and heartbeat).
 */
export function pauseSubAgent(id: string): void {
  updateSubAgentStatus(id, 'paused');
  logger.info('Sub-agent paused', { id });
}

/**
 * Resume a paused sub-agent.
 */
export function resumeSubAgent(id: string): void {
  updateSubAgentStatus(id, 'active');
  logger.info('Sub-agent resumed', { id });
}

/**
 * Disable a sub-agent permanently.
 */
export function disableSubAgent(id: string): void {
  updateSubAgentStatus(id, 'disabled');
  logger.info('Sub-agent disabled', { id });
}

import type { WorkerAgent } from './types.js';
import { logger } from '../core/logger.js';

const agents = new Map<string, WorkerAgent>();

/**
 * Register a worker agent.
 */
export function registerWorker(agent: WorkerAgent): void {
  if (agents.has(agent.name)) {
    logger.warn('Worker already registered, overwriting', { name: agent.name });
  }
  agents.set(agent.name, agent);
}

/**
 * Get a worker agent by name.
 */
export function getWorker(name: string): WorkerAgent | undefined {
  return agents.get(name);
}

/**
 * List all registered workers.
 */
export function listWorkers(): { name: string; supportedNodeTypes: string[] }[] {
  return Array.from(agents.values()).map(a => ({
    name: a.name,
    supportedNodeTypes: a.supportedNodeTypes,
  }));
}

/**
 * Find the worker that handles a given node type.
 * Matches by prefix: "gmail.list" matches worker supporting "gmail.*".
 */
export function findWorkerForNodeType(nodeType: string): WorkerAgent | undefined {
  for (const agent of agents.values()) {
    for (const pattern of agent.supportedNodeTypes) {
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1);
        if (nodeType.startsWith(prefix)) return agent;
      } else if (nodeType === pattern) {
        return agent;
      }
    }
  }
  return undefined;
}

/**
 * Clear all workers (for testing).
 */
export function clearWorkers(): void {
  agents.clear();
}

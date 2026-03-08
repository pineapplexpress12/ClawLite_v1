import { getNode, transitionNodeStatus, incrementRetryCount } from '../db/nodes.js';
import { getJob, incrementJobLLMCalls } from '../db/jobs.js';
import { insertRun, completeRun } from '../db/runs.js';
import { checkCircuitBreakers } from './circuitBreakers.js';
import { graphEvents } from '../core/events.js';
import { logger } from '../core/logger.js';

/**
 * Worker executor function type. Injected to avoid circular deps.
 */
export type WorkerExecutor = (
  nodeId: string,
  jobId: string,
) => Promise<{ output: Record<string, unknown>; costTokens: number }>;

let workerExecutor: WorkerExecutor | null = null;

export function setWorkerExecutor(executor: WorkerExecutor): void {
  workerExecutor = executor;
}

/**
 * Execute a single node: circuit breaker → dispatch to worker → update status.
 */
export async function runNode(nodeId: string): Promise<void> {
  const node = getNode(nodeId);
  if (!node) {
    throw new Error(`Node not found: ${nodeId}`);
  }

  const job = getJob(node.job_id);
  if (!job) {
    throw new Error(`Job not found for node: ${nodeId}`);
  }

  // Pre-execution circuit breaker
  const breakers = checkCircuitBreakers(job, node.token_budget);
  if (!breakers.ok) {
    logger.error('Circuit breaker blocked node', { nodeId, reason: breakers.reason });
    transitionNodeStatus(nodeId, 'cancelled');
    graphEvents.emitProgress(job.id, {
      type: 'circuit_breaker',
      nodeTitle: node.title,
      reason: breakers.reason,
    });
    throw new Error(`Circuit breaker: ${breakers.reason}`);
  }

  transitionNodeStatus(nodeId, 'running');
  const run = insertRun(nodeId);
  incrementJobLLMCalls(job.id);

  graphEvents.emitProgress(job.id, {
    type: 'node_started',
    nodeTitle: node.title,
    agentName: node.assigned_agent,
  });

  try {
    if (!workerExecutor) {
      throw new Error('No worker executor configured. Call setWorkerExecutor() first.');
    }

    const result = await workerExecutor(nodeId, job.id);

    transitionNodeStatus(nodeId, 'completed', result.output);
    completeRun(nodeId, 'completed', result.costTokens);

    graphEvents.emitProgress(job.id, {
      type: 'node_completed',
      nodeTitle: node.title,
      agentName: node.assigned_agent,
      summary: typeof result.output?.summary === 'string' ? result.output.summary : undefined,
    });

    logger.info('Node completed', { nodeId, costTokens: result.costTokens });
  } catch (err) {
    const errorMessage = (err as Error).message;
    logger.error('Node execution failed', { nodeId, error: errorMessage });

    completeRun(nodeId, 'failed', 0);

    graphEvents.emitProgress(job.id, {
      type: 'node_failed',
      nodeTitle: node.title,
      agentName: node.assigned_agent,
      reason: errorMessage,
      willRetry: node.retry_count < node.max_retries,
    });

    // Retry logic
    if (node.retry_count < node.max_retries) {
      incrementRetryCount(nodeId);
      transitionNodeStatus(nodeId, 'pending');
    } else {
      transitionNodeStatus(nodeId, 'failed', { error: errorMessage });
    }

    throw err;
  }
}

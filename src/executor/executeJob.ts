import { getJob, updateJobStatus } from '../db/jobs.js';
import { getNodesByJobId, countRunningNodes, type NodeRow } from '../db/nodes.js';
import { checkCircuitBreakers } from './circuitBreakers.js';
import { runNode } from './runNode.js';
import { graphEvents } from '../core/events.js';
import { logger } from '../core/logger.js';

/**
 * Event-driven job execution loop.
 * Schedules runnable nodes, reacts to completion/failure events, checks job completion.
 */
export async function executeJob(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job) {
    logger.error('Job not found', { jobId });
    return;
  }

  // Pre-flight circuit breaker
  const breakers = checkCircuitBreakers(job);
  if (!breakers.ok) {
    updateJobStatus(jobId, 'failed');
    graphEvents.emitProgress(jobId, {
      type: 'circuit_breaker',
      reason: breakers.reason,
    });
    graphEvents.cleanupJob(jobId);
    return;
  }

  updateJobStatus(jobId, 'running');
  logger.info('Starting job execution', { jobId, goal: job.goal });

  // Set up event listeners
  graphEvents.onNodeCompleted(jobId, async () => {
    await scheduleRunnableNodes(jobId);
    checkJobCompletion(jobId);
  });

  graphEvents.onNodeFailed(jobId, async (nodeId: string) => {
    // Check if the failed node was already retried via runNode
    // If node status is 'pending' it will be re-scheduled; if 'failed', check job completion
    const refreshedJob = getJob(jobId);
    if (refreshedJob && refreshedJob.status === 'running') {
      await scheduleRunnableNodes(jobId);
      checkJobCompletion(jobId);
    }
  });

  // Kick off initial runnable nodes
  await scheduleRunnableNodes(jobId);
}

async function scheduleRunnableNodes(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job || job.status !== 'running') return;

  // Circuit breaker before scheduling
  const breakers = checkCircuitBreakers(job);
  if (!breakers.ok) {
    logger.error('Circuit breaker tripped during scheduling', { jobId, reason: breakers.reason });
    updateJobStatus(jobId, 'failed');
    graphEvents.emitProgress(jobId, {
      type: 'circuit_breaker',
      reason: breakers.reason,
    });
    graphEvents.cleanupJob(jobId);
    return;
  }

  const nodes = getNodesByJobId(jobId);
  const runningCount = countRunningNodes(jobId);
  const runnableNodes = nodes.filter(n => isRunnable(n, nodes));

  for (const node of runnableNodes) {
    if (runningCount + runnableNodes.indexOf(node) >= job.max_parallel_workers) {
      break;
    }

    // Fire and forget — node emits events on completion/failure
    runNode(node.id)
      .then(() => {
        graphEvents.emitNodeCompleted(jobId, node.id);
      })
      .catch(() => {
        graphEvents.emitNodeFailed(jobId, node.id);
      });
  }
}

function isRunnable(node: NodeRow, allNodes: NodeRow[]): boolean {
  if (node.status !== 'pending') return false;

  const deps: string[] = JSON.parse(node.dependencies);
  return deps.every(depId => {
    const dep = allNodes.find(n => n.id === depId);
    return dep?.status === 'completed';
  });
}

function checkJobCompletion(jobId: string): void {
  const nodes = getNodesByJobId(jobId);
  const allDone = nodes.every(n =>
    ['completed', 'cancelled', 'failed'].includes(n.status),
  );

  if (!allDone) return;

  const hasFailed = nodes.some(n => n.status === 'failed');

  if (hasFailed) {
    updateJobStatus(jobId, 'failed');
    graphEvents.emitProgress(jobId, { type: 'job_failed', reason: 'One or more nodes failed' });
  } else {
    updateJobStatus(jobId, 'completed');
    graphEvents.emitProgress(jobId, { type: 'job_completed', summary: 'All nodes completed' });
  }

  graphEvents.cleanupJob(jobId);
  logger.info('Job finished', { jobId, status: hasFailed ? 'failed' : 'completed' });
}

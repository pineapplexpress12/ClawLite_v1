import { resetRunningNodesToPending } from '../../db/nodes.js';
import { getJobsByStatus, updateJobStatus } from '../../db/jobs.js';
import { logger } from '../../core/logger.js';

/**
 * Recover channel state on startup.
 * Reset running nodes to pending so they can be re-scheduled.
 */
export function recoverChannelState(): void {
  // Reset any nodes that were running when process crashed
  const resetCount = resetRunningNodesToPending();
  if (resetCount > 0) {
    logger.info('Reset interrupted nodes to pending', { count: resetCount });
  }

  // Mark jobs that were running but have no running nodes as needing review
  const runningJobs = getJobsByStatus(['running']);
  for (const job of runningJobs) {
    logger.info('Found interrupted job', { jobId: job.id, goal: job.goal });
    // Jobs remain in 'running' — they'll be picked up when nodes are re-scheduled
  }
}

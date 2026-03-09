import { stopHeartbeat } from './heartbeat/scheduler.js';
import { stopAllChannels } from './channels/registry.js';
import { stopHTTPServer } from './http/server.js';
import { closeDb } from './db/connection.js';
import { getJobsByStatus, updateJobStatus } from './db/jobs.js';
import { resetRunningNodesToPending } from './db/nodes.js';
import { executeJob } from './executor/executeJob.js';
import { logger } from './core/logger.js';

/**
 * Graceful shutdown handler.
 * Called on SIGINT/SIGTERM or `clawlite stop`.
 */
export async function gracefulShutdown(): Promise<void> {
  logger.info('Shutting down...');

  // 1. Stop heartbeat scheduler
  stopHeartbeat();

  // 2. Stop accepting new messages
  await stopAllChannels();

  // 3. Mark running nodes as interrupted (they'll resume on restart)
  const resetCount = resetRunningNodesToPending();
  if (resetCount > 0) {
    logger.info('Marked running nodes as pending for recovery', { count: resetCount });
  }

  // 4. Close HTTP server
  await stopHTTPServer();

  // 5. Close database
  closeDb();

  logger.info('Shutdown complete.');
}

/**
 * Recover from a crash on startup.
 * Reset running nodes to pending and re-execute active jobs.
 */
export function recoverCrashedJobs(): void {
  // Reset nodes that were mid-execution when crash happened
  const resetCount = resetRunningNodesToPending();
  if (resetCount > 0) {
    logger.info('Recovered crashed nodes', { count: resetCount });
  }

  // Re-attach to active jobs, but skip jobs that have been interrupted too many times
  const activeJobs = getJobsByStatus(['running', 'waiting_approval']);
  for (const job of activeJobs) {
    if (job.total_retries >= 2) {
      logger.warn('Marking repeatedly interrupted job as failed', { jobId: job.id, retries: job.total_retries });
      updateJobStatus(job.id, 'failed');
      continue;
    }
    logger.info('Re-executing interrupted job', { jobId: job.id });
    executeJob(job.id).catch(err => {
      logger.error('Failed to resume job', { jobId: job.id, error: (err as Error).message });
    });
  }
}

/**
 * Exit codes per CLAWSPEC.md Section 7b:
 * 0 = clean shutdown
 * 1 = startup failure
 * 2 = config error
 * 3 = database error
 * 4 = unhandled exception
 * 5 = signal (SIGKILL)
 */
export const EXIT_CODES = {
  CLEAN: 0,
  STARTUP_FAILURE: 1,
  CONFIG_ERROR: 2,
  DATABASE_ERROR: 3,
  UNHANDLED_EXCEPTION: 4,
  SIGNAL: 5,
} as const;

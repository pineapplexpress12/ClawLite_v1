import { logger } from '../core/logger.js';
import { runHeartbeatCheck } from './checker.js';

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the heartbeat scheduler.
 * Fires at the configured interval (in minutes).
 */
export function startHeartbeat(intervalMinutes: number): void {
  if (intervalHandle) {
    logger.warn('Heartbeat scheduler already running');
    return;
  }

  const intervalMs = intervalMinutes * 60 * 1000;
  logger.info('Heartbeat scheduler started', { intervalMinutes });

  intervalHandle = setInterval(() => {
    runHeartbeatCheck().catch(err => {
      logger.error('Heartbeat check failed', { error: (err as Error).message });
    });
  }, intervalMs);
}

/**
 * Stop the heartbeat scheduler.
 */
export function stopHeartbeat(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('Heartbeat scheduler stopped');
  }
}

/**
 * Check if the heartbeat scheduler is running.
 */
export function isHeartbeatRunning(): boolean {
  return intervalHandle !== null;
}

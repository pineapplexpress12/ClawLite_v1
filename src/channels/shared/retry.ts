import { logger } from '../../core/logger.js';

/**
 * Send a message with exponential backoff retry.
 */
export async function sendWithRetry(
  fn: () => Promise<void>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000,
): Promise<void> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await fn();
      return;
    } catch (err) {
      if (attempt === maxRetries) {
        logger.error('Send failed after all retries', { error: (err as Error).message, attempts: attempt + 1 });
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt);
      logger.warn('Send failed, retrying', { attempt: attempt + 1, delayMs: delay });
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

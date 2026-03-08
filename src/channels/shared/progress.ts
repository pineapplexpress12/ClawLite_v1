import { graphEvents, type ProgressEvent } from '../../core/events.js';
import type { ChannelAdapter } from '../types.js';
import { sendLongMessage } from './longMessage.js';

/**
 * Attach a progress listener for a job, forwarding updates to the channel.
 */
export function attachProgressListener(
  jobId: string,
  chatId: string,
  adapter: ChannelAdapter,
): void {
  graphEvents.onProgress(jobId, async (event: ProgressEvent) => {
    const text = formatProgressEvent(event);
    if (text) {
      try {
        await sendLongMessage(adapter, chatId, text, 'plain');
      } catch {
        // Silently swallow — progress updates are best-effort
      }
    }
  });
}

function formatProgressEvent(event: ProgressEvent): string | null {
  switch (event.type) {
    case 'node_started':
      return `Working on: ${event.nodeTitle ?? 'step'}...`;
    case 'node_completed':
      return event.summary
        ? `Done: ${event.nodeTitle}\n${event.summary}`
        : `Done: ${event.nodeTitle ?? 'step'}`;
    case 'node_failed':
      return event.willRetry
        ? `Step failed (retrying): ${event.nodeTitle} — ${event.reason}`
        : `Step failed: ${event.nodeTitle} — ${event.reason}`;
    case 'approval_needed':
      return `Approval needed: ${event.nodeTitle}\n${event.preview ?? ''}`;
    case 'circuit_breaker':
      return `Job stopped: ${event.reason}`;
    case 'job_completed':
      return event.summary ?? 'Job completed.';
    case 'job_failed':
      return `Job failed: ${event.reason}`;
    default:
      return null;
  }
}

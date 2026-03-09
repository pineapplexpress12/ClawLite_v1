import { existsSync } from 'node:fs';
import { selectTemplate } from '../../planner/templateSelector.js';
import { extractSlots } from '../../planner/slotExtractor.js';
import { buildTaskGraph } from '../../planner/buildTaskGraph.js';
import { handleAgenticFallback } from '../../planner/agenticFallback.js';
import { executeJob } from '../../executor/executeJob.js';
import { handleToolChat } from './chat.js';
import { graphEvents, type ProgressEvent } from '../../core/events.js';
import { isGwsReady } from '../../core/secrets.js';
import { logger } from '../../core/logger.js';

export interface ComplexContext {
  channelName: string;
  chatId: string;
  sendMessage: (text: string) => Promise<void>;
}

const GWS_TEMPLATE_KEYWORDS = ['inbox', 'calendar', 'draft', 'send_email', 'gmail', 'drive'];

/**
 * Check if a template requires Google Workspace.
 */
function templateNeedsGws(template: { id?: string; name?: string }): boolean {
  const templateId = template.id || template.name?.toLowerCase().replace(/\s+/g, '_') || '';
  return GWS_TEMPLATE_KEYWORDS.some(kw => templateId.includes(kw));
}

/**
 * Attach a lightweight progress listener that reports job results to the user.
 */
function listenForJobProgress(
  jobId: string,
  sendMessage: (text: string) => Promise<void>,
): void {
  graphEvents.onProgress(jobId, async (event: ProgressEvent) => {
    try {
      switch (event.type) {
        case 'node_completed':
          if (event.summary) {
            await sendMessage(event.summary);
          }
          break;
        case 'node_failed':
          if (!event.willRetry) {
            await sendMessage(`Step failed: ${event.nodeTitle ?? 'unknown'} — ${event.reason ?? 'unknown error'}`);
          }
          break;
        case 'job_completed':
          if (event.summary && event.summary !== 'All nodes completed') {
            await sendMessage(event.summary);
          }
          break;
        case 'job_failed':
          await sendMessage(`Job failed: ${event.reason ?? 'one or more steps failed'}`);
          break;
        case 'circuit_breaker':
          await sendMessage(`Job stopped: ${event.reason ?? 'limit reached'}`);
          break;
      }
    } catch {
      // Best-effort — don't crash the progress listener
    }
  });
}

/**
 * Complex message handler — template selection → job creation → execution.
 * Falls back to chat handler for low confidence (conversational messages).
 * Falls back to agentic plan generation for medium confidence.
 */
export async function handleComplex(
  text: string,
  ctx: ComplexContext,
): Promise<void> {
  try {
    const selection = await selectTemplate(text);

    // Low confidence → fall back to tool-capable chat (not a dead end)
    if (selection.fallback === 'chat' || selection.confidence < 0.3) {
      await handleToolChat(text, ctx);
      return;
    }

    // Medium confidence → bounded agentic fallback
    if (selection.fallback === 'agentic' || (selection.confidence >= 0.3 && selection.confidence < 0.7)) {
      await ctx.sendMessage('Planning a custom workflow...');
      try {
        const result = await handleAgenticFallback({
          message: text,
          triggerType: 'channel_message',
          channel: ctx.channelName,
          chatId: ctx.chatId,
        });

        await ctx.sendMessage(`Started agentic job (${result.nodeIds.length} steps)`);

        listenForJobProgress(result.jobId, ctx.sendMessage);
        executeJob(result.jobId).catch(err => {
          logger.error('Agentic job failed', { jobId: result.jobId, error: (err as Error).message });
          ctx.sendMessage(`Job failed: ${(err as Error).message}`).catch(() => {});
        });
      } catch (err) {
        await ctx.sendMessage(`Failed to plan: ${(err as Error).message}`);
      }
      return;
    }

    // High confidence → execute template
    if (selection.template) {
      // Pre-flight: if template needs GWS and GWS isn't connected, redirect to tool chat
      if (templateNeedsGws(selection.template) && !isGwsReady()) {
        await ctx.sendMessage(
          "Google Workspace isn't connected yet. Let me set that up for you — I'll open the Google authorization page in your browser."
        );
        await handleToolChat(
          "The user asked to check their inbox but Google Workspace is not connected. Use the gws_connect tool to install and connect Google Workspace. Tell the user what's happening.",
          ctx,
        );
        return;
      }

      const slots = await extractSlots(selection.template, text);
      const result = buildTaskGraph({
        template: selection.template,
        slots,
        triggerType: 'channel_message',
        channel: ctx.channelName,
        chatId: ctx.chatId,
      });

      await ctx.sendMessage(`Starting: ${selection.template.name} (${result.nodeIds.length} steps)`);

      listenForJobProgress(result.jobId, ctx.sendMessage);
      executeJob(result.jobId).catch(err => {
        logger.error('Job execution failed', { jobId: result.jobId, error: (err as Error).message });
        ctx.sendMessage(`Job failed: ${(err as Error).message}`).catch(() => {});
      });
    }
  } catch (err) {
    logger.error('Complex handler failed', { error: (err as Error).message });
    await ctx.sendMessage(`Something went wrong: ${(err as Error).message}`);
  }
}

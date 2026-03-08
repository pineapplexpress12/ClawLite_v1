import { selectTemplate } from '../../planner/templateSelector.js';
import { extractSlots } from '../../planner/slotExtractor.js';
import { buildTaskGraph } from '../../planner/buildTaskGraph.js';
import { handleAgenticFallback } from '../../planner/agenticFallback.js';
import { executeJob } from '../../executor/executeJob.js';
import { handleChat } from './chat.js';
import { logger } from '../../core/logger.js';

export interface ComplexContext {
  channelName: string;
  chatId: string;
  sendMessage: (text: string) => Promise<void>;
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

    // Low confidence → fall back to chat handler (not a dead end)
    if (selection.fallback === 'chat' || selection.confidence < 0.3) {
      await handleChat(text, ctx);
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

        executeJob(result.jobId).catch(err => {
          logger.error('Agentic job failed', { jobId: result.jobId, error: (err as Error).message });
        });
      } catch (err) {
        await ctx.sendMessage(`Failed to plan: ${(err as Error).message}`);
      }
      return;
    }

    // High confidence → execute template
    if (selection.template) {
      const slots = await extractSlots(selection.template, text);
      const result = buildTaskGraph({
        template: selection.template,
        slots,
        triggerType: 'channel_message',
        channel: ctx.channelName,
        chatId: ctx.chatId,
      });

      await ctx.sendMessage(`Starting: ${selection.template.name} (${result.nodeIds.length} steps)`);

      executeJob(result.jobId).catch(err => {
        logger.error('Job execution failed', { jobId: result.jobId, error: (err as Error).message });
      });
    }
  } catch (err) {
    logger.error('Complex handler failed', { error: (err as Error).message });
    await ctx.sendMessage(`Something went wrong: ${(err as Error).message}`);
  }
}

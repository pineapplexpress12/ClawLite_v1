import { getTemplateBySlashCommand } from '../../planner/templates.js';
import { extractSlashArgs } from '../../planner/slotExtractor.js';
import { buildTaskGraph } from '../../planner/buildTaskGraph.js';
import { executeJob } from '../../executor/executeJob.js';
import { logger } from '../../core/logger.js';

export interface CommandContext {
  channelName: string;
  chatId: string;
  sendMessage: (text: string) => Promise<void>;
}

/**
 * Parse and dispatch slash commands.
 * Returns true if handled, false if unknown command.
 */
export async function handleCommand(
  text: string,
  ctx: CommandContext,
): Promise<boolean> {
  const trimmed = text.trim();
  const spaceIdx = trimmed.indexOf(' ');
  const command = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  // Check for workflow template commands
  const template = getTemplateBySlashCommand(command);
  if (template) {
    const slots = extractSlashArgs(template, args);

    // Check required slots
    const missing = template.slots.filter(s => s.required && !slots[s.name]);
    if (missing.length > 0) {
      await ctx.sendMessage(
        `Missing required info: ${missing.map(s => s.name).join(', ')}. Usage: ${command} <${missing.map(s => s.name).join('> <')}>`,
      );
      return true;
    }

    const dryRun = command === '/dryrun';
    const result = buildTaskGraph({
      template,
      slots,
      triggerType: 'channel_message',
      channel: ctx.channelName,
      chatId: ctx.chatId,
      dryRun,
    });

    await ctx.sendMessage(`Starting: ${template.name} (${result.nodeIds.length} steps)`);

    executeJob(result.jobId).catch(err => {
      logger.error('Job execution failed', { jobId: result.jobId, error: (err as Error).message });
    });

    return true;
  }

  // Not a workflow command — return false so system/profile/heartbeat handlers can try
  return false;
}

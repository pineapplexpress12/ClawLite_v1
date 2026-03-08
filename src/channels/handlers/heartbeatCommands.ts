import type { CommandContext } from './commands.js';

/**
 * Handle heartbeat commands: /heartbeat list|add|remove|now
 * Returns true if handled.
 */
export async function handleHeartbeatCommand(
  command: string,
  args: string,
  ctx: CommandContext,
): Promise<boolean> {
  if (command !== '/heartbeat') return false;

  const subCommand = args.split(' ')[0] ?? '';
  const rest = args.slice(subCommand.length).trim();

  switch (subCommand) {
    case 'list':
      await ctx.sendMessage('*Heartbeat Conditions*\nNo conditions configured yet. Use /heartbeat add <condition>.');
      return true;

    case 'add':
      if (!rest) {
        await ctx.sendMessage('Usage: /heartbeat add <condition description>');
        return true;
      }
      await ctx.sendMessage(`Heartbeat condition added: "${rest}"`);
      return true;

    case 'remove':
      if (!rest) {
        await ctx.sendMessage('Usage: /heartbeat remove <condition>');
        return true;
      }
      await ctx.sendMessage(`Heartbeat condition removed: "${rest}"`);
      return true;

    case 'now':
      await ctx.sendMessage('Triggering heartbeat check...');
      return true;

    default:
      await ctx.sendMessage('Usage: /heartbeat list|add|remove|now');
      return true;
  }
}

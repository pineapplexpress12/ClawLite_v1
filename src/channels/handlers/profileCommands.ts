import { ingestMemory } from '../../memory/store.js';
import { searchMemoryFts } from '../../db/memory.js';
import type { CommandContext } from './commands.js';

/**
 * Handle profile commands: /remember, /forget, /profile, /memory
 * Returns true if handled.
 */
export async function handleProfileCommand(
  command: string,
  args: string,
  ctx: CommandContext,
): Promise<boolean> {
  switch (command) {
    case '/remember': {
      if (!args) {
        await ctx.sendMessage('Usage: /remember <fact about you>');
        return true;
      }
      ingestMemory({
        content: args,
        type: 'semantic',
        tags: ['user_profile'],
        tokenCount: Math.ceil(args.length / 4),
      });
      await ctx.sendMessage(`Remembered: "${args}"`);
      return true;
    }

    case '/forget': {
      if (!args) {
        await ctx.sendMessage('Usage: /forget <topic>');
        return true;
      }
      // Search for matching memories and note them
      const matches = searchMemoryFts(args, 5);
      if (matches.length === 0) {
        await ctx.sendMessage(`No memories found matching "${args}".`);
      } else {
        await ctx.sendMessage(`Found ${matches.length} related memories. (Deletion via /forget will be implemented with memory management.)`);
      }
      return true;
    }

    case '/profile': {
      const memories = searchMemoryFts('user_profile', 10);
      if (memories.length === 0) {
        await ctx.sendMessage("I don't have any profile information stored. Use /remember to teach me about you.");
        return true;
      }
      const lines = memories.map(m => `- ${m.content}`);
      await ctx.sendMessage(`*Your Profile*\n${lines.join('\n')}`);
      return true;
    }

    case '/memory': {
      if (args.startsWith('search ')) {
        const query = args.slice(7).trim();
        const results = searchMemoryFts(query, 5);
        if (results.length === 0) {
          await ctx.sendMessage(`No memories found for "${query}".`);
        } else {
          const lines = results.map(m => `- [${m.type}] ${m.content.slice(0, 80)}`);
          await ctx.sendMessage(`*Memory Search: "${query}"*\n${lines.join('\n')}`);
        }
      } else {
        const results = searchMemoryFts('', 10);
        await ctx.sendMessage(`*Recent Memories*\n${results.length} items stored.`);
      }
      return true;
    }

    default:
      return false;
  }
}

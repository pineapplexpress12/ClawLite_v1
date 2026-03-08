import type { Command } from 'commander';

/**
 * Register the send command — terminal as a channel.
 */
export function registerSendCommand(program: Command): void {
  program
    .command('send <message>')
    .description('Send a message to the agent from the terminal')
    .action(async (message: string) => {
      const { loadConfig } = await import('../core/config.js');
      const { initDb } = await import('../db/connection.js');
      loadConfig();
      initDb();

      const { routeMessage } = await import('../router/messageRouter.js');

      const route = routeMessage(message);
      console.log(`Routing: ${route}`);

      if (route === 'chat') {
        // Quick chat response via fast tier
        const { complete } = await import('../llm/provider.js');
        const result = await complete({
          model: 'fast',
          messages: [
            { role: 'system', content: 'You are a helpful AI assistant.' },
            { role: 'user', content: message },
          ],
        });
        console.log(result.text);
      } else if (route === 'command') {
        console.log(`Command detected: ${message}`);
      } else {
        console.log('Complex request detected. Would create a job in full mode.');
      }
    });
}

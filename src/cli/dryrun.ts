import type { Command } from 'commander';

/**
 * Register the dryrun command.
 */
export function registerDryrunCommand(program: Command): void {
  program
    .command('dryrun <goal>')
    .description('Run a job in dry-run mode (no external side effects)')
    .action(async (goal: string) => {
      const { loadConfig } = await import('../core/config.js');
      const { initDb } = await import('../db/connection.js');
      loadConfig();
      initDb();

      console.log(`[DRY RUN] Goal: ${goal}`);
      console.log('[DRY RUN] Would select template and create job with dryRun=true');
      console.log('[DRY RUN] No external actions taken. 0 tokens consumed.');
    });
}

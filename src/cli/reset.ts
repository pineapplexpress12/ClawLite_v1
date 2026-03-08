import type { Command } from 'commander';

/**
 * Register destructive reset commands.
 */
export function registerResetCommands(program: Command): void {
  program
    .command('reset')
    .description('Reset data (destructive)')
    .option('--sessions', 'Clear all session history')
    .option('--memory', 'Clear all memory items')
    .option('--memory-type <type>', 'Clear only a specific memory type')
    .option('--jobs', 'Clear job history')
    .option('--all', 'Reset everything except config.json')
    .option('--yes', 'Skip confirmation')
    .action(async (options) => {
      const { loadConfig } = await import('../core/config.js');
      const { initDb, getDb } = await import('../db/connection.js');
      loadConfig();
      initDb();
      const db = getDb();

      if (!options.sessions && !options.memory && !options.jobs && !options.all && !options.memoryType) {
        console.log('Specify what to reset: --sessions, --memory, --jobs, or --all');
        return;
      }

      if (options.all) {
        if (!options.yes) {
          console.log('\u26a0 This will permanently delete all data except config.json.');
          console.log('Use --yes to confirm.');
          return;
        }

        db.exec('DELETE FROM sessions');
        db.exec('DELETE FROM memory');
        db.exec('DELETE FROM nodes');
        db.exec('DELETE FROM jobs');
        db.exec('DELETE FROM artifacts');
        db.exec('DELETE FROM ledger');
        db.exec('DELETE FROM approvals');
        db.exec('UPDATE daily_budget SET tokens_consumed = 0 WHERE id = 1');
        console.log('\u2713 All data reset.');
        return;
      }

      if (options.sessions) {
        db.exec('DELETE FROM sessions');
        console.log('\u2713 Sessions cleared.');
      }

      if (options.memory) {
        db.exec('DELETE FROM memory');
        console.log('\u2713 Memory cleared.');
      }

      if (options.memoryType) {
        db.prepare('DELETE FROM memory WHERE type = ?').run(options.memoryType);
        console.log(`\u2713 ${options.memoryType} memories cleared.`);
      }

      if (options.jobs) {
        db.exec('DELETE FROM nodes');
        db.exec('DELETE FROM jobs');
        db.exec('DELETE FROM artifacts');
        console.log('\u2713 Jobs and artifacts cleared.');
      }
    });
}

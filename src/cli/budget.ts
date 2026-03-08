import type { Command } from 'commander';

/**
 * Register budget display command.
 */
export function registerBudgetCommand(program: Command): void {
  program
    .command('budget')
    .description('Show daily budget usage')
    .action(async () => {
      const { loadConfig, getConfig } = await import('../core/config.js');
      const { initDb } = await import('../db/connection.js');
      loadConfig();
      initDb();

      const { getDailyBudget } = await import('../db/dailyBudget.js');
      const config = getConfig();
      const budget = getDailyBudget();

      const limit = config.budgets.dailyTokens;
      const consumed = budget.tokens_consumed;
      const remaining = limit - consumed;
      const pct = (consumed / limit) * 100;

      const barLen = 20;
      const filled = Math.round((consumed / limit) * barLen);
      const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barLen - filled);

      console.log('Daily token budget:');
      console.log(`  Window start: ${new Date(budget.window_start).toISOString()}`);
      console.log(`  Consumed:     ${consumed.toLocaleString()} tokens`);
      console.log(`  Remaining:    ${remaining.toLocaleString()} tokens`);
      console.log(`  Limit:        ${limit.toLocaleString()} tokens`);
      console.log(`  Usage:        ${bar} ${pct.toFixed(1)}%`);
    });
}

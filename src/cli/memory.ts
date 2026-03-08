import type { Command } from 'commander';

/**
 * Register memory listing and search commands.
 */
export function registerMemoryCommands(program: Command): void {
  const mem = program
    .command('memory')
    .description('Memory management');

  mem
    .command('list')
    .description('List recent memory items')
    .option('-n, --limit <count>', 'Number to show', '20')
    .action(async (options) => {
      const { loadConfig } = await import('../core/config.js');
      const { initDb, getDb } = await import('../db/connection.js');
      loadConfig();
      initDb();

      const db = getDb();
      const rows = db.prepare('SELECT * FROM memory ORDER BY created_at DESC LIMIT ?')
        .all(parseInt(options.limit, 10)) as any[];

      if (rows.length === 0) {
        console.log('No memory items found.');
        return;
      }

      console.log('ID          Type       Created     Content');
      console.log('-'.repeat(70));
      for (const row of rows) {
        const age = getAge(row.created_at);
        const content = row.content.slice(0, 50).replace(/\n/g, ' ');
        console.log(`${row.id.slice(0, 10)}  ${row.type.padEnd(10)} ${age.padEnd(11)} ${content}`);
      }
    });

  mem
    .command('search <query>')
    .description('Search memory via FTS5')
    .action(async (query: string) => {
      const { loadConfig } = await import('../core/config.js');
      const { initDb } = await import('../db/connection.js');
      loadConfig();
      initDb();

      const { searchMemoryFts } = await import('../db/memory.js');
      const results = searchMemoryFts(query, 20);

      if (results.length === 0) {
        console.log(`No results for "${query}".`);
        return;
      }

      for (const r of results) {
        console.log(`[${r.type}] ${r.content.slice(0, 80)}`);
      }
    });

  mem
    .command('count')
    .description('Show memory item count by type')
    .action(async () => {
      const { loadConfig } = await import('../core/config.js');
      const { initDb } = await import('../db/connection.js');
      loadConfig();
      initDb();

      const { countMemoriesByType } = await import('../db/memory.js');
      const counts = countMemoriesByType();
      console.log('Memory items by type:');
      for (const [type, count] of Object.entries(counts)) {
        console.log(`  ${type}: ${count}`);
      }
    });
}

function getAge(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

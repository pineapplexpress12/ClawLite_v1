import type { Command } from 'commander';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Register database management commands.
 */
export function registerDbCommands(program: Command): void {
  const db = program
    .command('db')
    .description('Database management');

  db
    .command('backup')
    .description('Backup the SQLite database')
    .action(async () => {
      const home = process.env.CLAWLITE_HOME ?? join(process.env.HOME ?? '', '.clawlite');
      const dbPath = join(home, 'clawlite.db');
      const backupDir = join(home, 'backups');

      if (!existsSync(dbPath)) {
        console.error('Database not found.');
        process.exit(1);
      }

      if (!existsSync(backupDir)) {
        mkdirSync(backupDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupPath = join(backupDir, `clawlite_${timestamp}.db`);
      copyFileSync(dbPath, backupPath);
      console.log(`\u2713 Backup saved to ${backupPath}`);
    });

  db
    .command('vacuum')
    .description('Run SQLite VACUUM to reclaim disk space')
    .action(async () => {
      const { loadConfig } = await import('../core/config.js');
      const { initDb, getDb } = await import('../db/connection.js');
      loadConfig();
      initDb();

      const database = getDb();
      database.exec('VACUUM');
      console.log('\u2713 Database vacuumed.');
    });

  db
    .command('stats')
    .description('Show database size and table row counts')
    .action(async () => {
      const { loadConfig } = await import('../core/config.js');
      const { initDb, getDb } = await import('../db/connection.js');
      loadConfig();
      initDb();

      const database = getDb();
      const tables = ['jobs', 'nodes', 'runs', 'ledger', 'memory', 'sessions', 'sub_agents', 'approvals', 'artifacts'];

      console.log('Database statistics:');
      console.log('-'.repeat(40));
      for (const table of tables) {
        try {
          const row = database.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as any;
          console.log(`  ${table.padEnd(15)} ${row.count} rows`);
        } catch {
          console.log(`  ${table.padEnd(15)} (not found)`);
        }
      }
    });
}

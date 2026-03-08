import type { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Register log viewing commands.
 */
export function registerLogCommands(program: Command): void {
  program
    .command('logs')
    .description('View ClawLite logs')
    .option('--follow', 'Live tail (like tail -f)')
    .option('--level <level>', 'Filter by log level (debug, info, warn, error)')
    .option('--since <duration>', 'Show logs from duration (e.g., 1h, 30m, 1d)')
    .option('-n, --lines <count>', 'Number of lines to show', '50')
    .action((options) => {
      const home = process.env.CLAWLITE_HOME ?? join(process.env.HOME ?? '', '.clawlite');
      const logPath = join(home, 'logs', 'daemon.log');

      if (!existsSync(logPath)) {
        console.log('No log file found. Start ClawLite first.');
        return;
      }

      const content = readFileSync(logPath, 'utf-8');
      let lines = content.split('\n').filter(l => l.trim());

      // Filter by level
      if (options.level) {
        lines = lines.filter(l => {
          try {
            const parsed = JSON.parse(l);
            return parsed.level === options.level;
          } catch {
            return false;
          }
        });
      }

      // Filter by time
      if (options.since) {
        const since = parseDuration(options.since);
        const cutoff = Date.now() - since;
        lines = lines.filter(l => {
          try {
            const parsed = JSON.parse(l);
            return new Date(parsed.timestamp).getTime() >= cutoff;
          } catch {
            return true;
          }
        });
      }

      // Limit lines
      const count = parseInt(options.lines, 10);
      lines = lines.slice(-count);

      for (const line of lines) {
        console.log(line);
      }

      if (options.follow) {
        console.log('\n-- Following logs (Ctrl+C to stop) --');
        // In a real implementation, this would use fs.watch or tail
      }
    });
}

function parseDuration(dur: string): number {
  const match = dur.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 3600000; // default 1h
  const val = parseInt(match[1]!, 10);
  const unit = match[2]!;
  switch (unit) {
    case 's': return val * 1000;
    case 'm': return val * 60000;
    case 'h': return val * 3600000;
    case 'd': return val * 86400000;
    default: return 3600000;
  }
}

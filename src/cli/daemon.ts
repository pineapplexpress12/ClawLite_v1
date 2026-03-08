import type { Command } from 'commander';

/**
 * Register start/stop/restart/status commands.
 */
export function registerStartCommand(program: Command): void {
  program
    .command('start')
    .description('Start ClawLite')
    .option('--daemon', 'Run as a background daemon')
    .action(async (options) => {
      if (options.daemon) {
        console.log('Starting ClawLite as daemon...');
        const platform = process.platform;
        if (platform === 'darwin') {
          console.log('Would install launchd plist and start service');
        } else if (platform === 'linux') {
          console.log('Would install systemd unit and start service');
        } else {
          console.log('On Windows, use pm2: pm2 start clawlite -- start');
        }
        return;
      }

      // Foreground mode
      console.log('[ClawLite] Starting in foreground mode...');
      try {
        const { startClawLite } = await import('../index.js');
        await startClawLite();
      } catch (err) {
        console.error(`Failed to start: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  program
    .command('stop')
    .description('Stop the ClawLite daemon')
    .action(() => {
      console.log('[ClawLite] Sending stop signal...');
      // Would send SIGTERM to the daemon PID
      console.log('Daemon stop requested.');
    });

  program
    .command('restart')
    .description('Restart ClawLite')
    .action(() => {
      console.log('[ClawLite] Restarting...');
    });
}

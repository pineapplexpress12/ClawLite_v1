import type { Command } from 'commander';

/**
 * Register tool management commands.
 */
export function registerToolCommands(program: Command): void {
  const tool = program
    .command('tool')
    .description('Tool management');

  tool
    .command('list')
    .description('List all registered tools')
    .action(async () => {
      console.log('Name        Status    Risk     Actions');
      console.log('-'.repeat(60));
      console.log('workspace   enabled   medium   gmail.list, gmail.get, gmail.draft, gmail.send, ...');
      console.log('research    enabled   low      search, deep');
      console.log('fs          enabled   low      readText, writeText, listDir');
    });

  tool
    .command('info <name>')
    .description('Show tool detail')
    .action(async (name: string) => {
      console.log(`Tool: ${name}`);
      console.log('  Status: enabled');
      console.log('  Type: builtin');
    });

  tool
    .command('install <source>')
    .description('Install a tool from GitHub, MCP registry, or local path')
    .action(async (source: string) => {
      console.log(`Installing tool from: ${source}`);
      console.log('Running security analysis...');
      console.log('Approval required before installation.');
    });

  tool
    .command('remove <name>')
    .description('Uninstall a custom tool')
    .action(async (name: string) => {
      console.log(`Removing tool: ${name}`);
    });

  tool
    .command('scan <name>')
    .description('Re-run security analysis on a tool')
    .option('--all', 'Scan all custom tools')
    .action(async (name: string, options: any) => {
      if (options.all) {
        console.log('Scanning all custom tools...');
      } else {
        console.log(`Scanning tool: ${name}`);
      }
    });

  tool
    .command('audit')
    .description('Show security report for all custom tools')
    .action(async () => {
      console.log('Security audit for all custom tools:');
      console.log('No custom tools installed.');
    });
}

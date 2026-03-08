import type { Command } from 'commander';
import {
  loadRawConfig,
  saveRawConfig,
  getNestedValue,
  setNestedValue,
  parseValue,
  redactSecrets,
} from '../core/configIO.js';

/**
 * Register config get/set/show/validate commands.
 */
export function registerConfigCommands(program: Command): void {
  const config = program
    .command('config')
    .description('Configuration management');

  config
    .command('get <key>')
    .description('Get a config value (dot notation)')
    .action((key: string) => {
      try {
        const configData = loadRawConfig();
        const value = getNestedValue(configData, key);
        if (value === undefined) {
          console.log(`Key "${key}" not found`);
          process.exit(1);
        }
        console.log(typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    });

  config
    .command('set <key> <value>')
    .description('Set a config value')
    .action((key: string, value: string) => {
      try {
        const configData = loadRawConfig();
        setNestedValue(configData, key, parseValue(value));
        saveRawConfig(configData);
        console.log(`\u2713 ${key} \u2192 ${value}`);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    });

  config
    .command('show')
    .description('Print full config (secrets redacted)')
    .action(() => {
      try {
        const configData = loadRawConfig();
        const redacted = redactSecrets(configData);
        console.log(JSON.stringify(redacted, null, 2));
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    });

  config
    .command('validate')
    .description('Validate config.json against schema')
    .action(async () => {
      try {
        const { ClawLiteConfigSchema } = await import('../core/config.js');
        const configData = loadRawConfig();
        const result = ClawLiteConfigSchema.safeParse(configData);
        if (result.success) {
          console.log('\u2713 Config is valid');
        } else {
          console.error('Config validation errors:');
          for (const issue of result.error.issues) {
            console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
          }
          process.exit(1);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    });
}


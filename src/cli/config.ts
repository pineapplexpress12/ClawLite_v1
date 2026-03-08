import type { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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

function getConfigPath(): string {
  const home = process.env.CLAWLITE_HOME ?? join(process.env.HOME ?? '', '.clawlite');
  return join(home, 'config.json');
}

function loadRawConfig(): Record<string, unknown> {
  const path = getConfigPath();
  if (!existsSync(path)) throw new Error(`Config not found: ${path}. Run "clawlite setup" first.`);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function saveRawConfig(data: Record<string, unknown>): void {
  writeFileSync(getConfigPath(), JSON.stringify(data, null, 2));
}

function getNestedValue(obj: any, path: string): unknown {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

function setNestedValue(obj: any, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const parent = keys.reduce((o, k) => {
    if (!(k in o)) o[k] = {};
    return o[k];
  }, obj);
  parent[last] = value;
}

function parseValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== '') return num;
  return value;
}

function redactSecrets(obj: any): any {
  if (typeof obj !== 'object' || obj === null) return obj;
  const result: any = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj)) {
    if (/key|token|secret|password/i.test(key) && typeof value === 'string') {
      result[key] = value.slice(0, 6) + '***REDACTED***';
    } else if (typeof value === 'object') {
      result[key] = redactSecrets(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

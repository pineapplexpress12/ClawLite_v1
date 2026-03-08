import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getClawliteHome } from '../db/connection.js';

/**
 * Shared config I/O helpers used by both CLI and tools.
 */

export function getConfigPath(): string {
  return join(getClawliteHome(), 'config.json');
}

export function loadRawConfig(): Record<string, unknown> {
  const path = getConfigPath();
  if (!existsSync(path)) throw new Error(`Config not found: ${path}. Run "clawlite setup" first.`);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function saveRawConfig(data: Record<string, unknown>): void {
  writeFileSync(getConfigPath(), JSON.stringify(data, null, 2));
}

export function getNestedValue(obj: any, path: string): unknown {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

export function setNestedValue(obj: any, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const parent = keys.reduce((o, k) => {
    if (!(k in o)) o[k] = {};
    return o[k];
  }, obj);
  parent[last] = value;
}

export function parseValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== '') return num;
  return value;
}

export function redactSecrets(obj: any): any {
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

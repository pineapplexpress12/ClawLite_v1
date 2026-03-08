import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getClawliteHome } from '../db/connection.js';

let secretsMap: Map<string, string> = new Map();

export function getEnvPath(): string {
  return join(getClawliteHome(), '.env');
}

/**
 * Load .env file into memory. Called at startup.
 */
export function loadSecrets(path?: string): void {
  const envPath = path ?? getEnvPath();
  secretsMap = new Map();

  if (!existsSync(envPath)) {
    return;
  }

  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    secretsMap.set(key, value);
  }
}

/**
 * Get a secret by key name. Tools should use ctx.secrets.get() which calls this.
 */
export function getSecret(key: string): string | undefined {
  return secretsMap.get(key);
}

/**
 * Check if a secret exists.
 */
export function hasSecret(key: string): boolean {
  return secretsMap.has(key);
}

/**
 * Append or update a key in the .env file. Hot-reloads into memory immediately.
 */
export function appendToEnvFile(key: string, value: string): void {
  const envPath = getEnvPath();
  const dir = dirname(envPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let lines: string[] = [];

  if (existsSync(envPath)) {
    lines = readFileSync(envPath, 'utf-8').split('\n');
  }

  // Check if key already exists — update in place
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const existingKey = trimmed.slice(0, eqIndex).trim();
    if (existingKey === key) {
      lines[i] = `${key}=${value}`;
      found = true;
      break;
    }
  }

  if (!found) {
    // Add a newline before if file doesn't end with one
    if (lines.length > 0 && lines[lines.length - 1]!.trim() !== '') {
      lines.push('');
    }
    lines.push(`${key}=${value}`);
  }

  writeFileSync(envPath, lines.join('\n'), 'utf-8');

  // Hot-reload into memory
  secretsMap.set(key, value);
}

/**
 * Remove a key from the .env file and memory.
 */
export function removeSecret(key: string): void {
  secretsMap.delete(key);

  const envPath = getEnvPath();
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, 'utf-8').split('\n');
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return true;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) return true;
    return trimmed.slice(0, eqIndex).trim() !== key;
  });

  writeFileSync(envPath, filtered.join('\n'), 'utf-8');
}

/**
 * Get all loaded secret keys (not values — for listing/debugging).
 */
export function listSecretKeys(): string[] {
  return Array.from(secretsMap.keys());
}

/**
 * Create a secrets accessor for tool contexts.
 */
export function createSecretsAccessor(): { get: (key: string) => string | undefined; has: (key: string) => boolean } {
  return {
    get: getSecret,
    has: hasSecret,
  };
}

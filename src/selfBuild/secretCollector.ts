import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getClawliteHome } from '../db/connection.js';
import { logger } from '../core/logger.js';

/**
 * Append a secret to the .env file.
 * Used when the user provides API keys through conversation.
 */
export function appendToEnvFile(key: string, value: string): void {
  const envPath = join(getClawliteHome(), '.env');

  // Create .env if it doesn't exist
  if (!existsSync(envPath)) {
    writeFileSync(envPath, '');
  }

  // Check if key already exists
  const content = readFileSync(envPath, 'utf-8');
  const lines = content.split('\n');
  const existingIndex = lines.findIndex(l => l.startsWith(`${key}=`));

  if (existingIndex >= 0) {
    // Replace existing
    lines[existingIndex] = `${key}=${value}`;
    writeFileSync(envPath, lines.join('\n'));
  } else {
    // Append new
    const newLine = content.endsWith('\n') || content === '' ? '' : '\n';
    appendFileSync(envPath, `${newLine}${key}=${value}\n`);
  }

  // Set in current process
  process.env[key] = value;
  logger.info('Secret saved to .env', { key });
}

/**
 * Check if a secret exists in the environment.
 */
export function hasSecret(key: string): boolean {
  return !!process.env[key];
}

/**
 * List which required secrets are missing from a set of required keys.
 */
export function getMissingSecrets(requiredKeys: string[]): string[] {
  return requiredKeys.filter(k => !process.env[k]);
}

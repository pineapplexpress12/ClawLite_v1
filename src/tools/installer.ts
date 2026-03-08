import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getClawliteHome } from '../db/connection.js';
import { analyzeToolSecurity, type SecurityAnalysisResult } from './sdk/securityAnalysis.js';
import { logger } from '../core/logger.js';

export interface ToolLockEntry {
  source: string;
  version: string;
  commit?: string;
  installedAt: number;
  securityScore: number;
  acknowledgedWarnings: string[];
}

export type ToolLock = Record<string, ToolLockEntry>;

function getLockFilePath(): string {
  return join(getClawliteHome(), 'tools.lock.json');
}

function getCustomToolsDir(): string {
  return join(getClawliteHome(), 'tools', 'custom');
}

export function readToolLock(): ToolLock {
  const path = getLockFilePath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf-8')) as ToolLock;
}

export function writeToolLock(lock: ToolLock): void {
  writeFileSync(getLockFilePath(), JSON.stringify(lock, null, 2), 'utf-8');
}

/**
 * Analyze a tool's source code before installation.
 */
export function preInstallScan(
  sourceCode: string,
  fileName: string,
  declaredPermissions: string[] = [],
): SecurityAnalysisResult {
  return analyzeToolSecurity(sourceCode, fileName, declaredPermissions);
}

/**
 * Install a tool from source code (after security scan + user approval).
 */
export function installToolFromSource(
  name: string,
  sourceCode: string,
  source: string,
  version: string,
  acknowledgedWarnings: string[],
  securityScore: number,
  commit?: string,
): void {
  const dir = getCustomToolsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const filePath = join(dir, `${name}.tool.ts`);
  writeFileSync(filePath, sourceCode, 'utf-8');

  // Update lock file
  const lock = readToolLock();
  lock[name] = {
    source,
    version,
    commit,
    installedAt: Date.now(),
    securityScore,
    acknowledgedWarnings,
  };
  writeToolLock(lock);

  logger.info(`Tool installed: ${name}`, { source, version, securityScore });
}

/**
 * Remove a custom tool.
 */
export function removeInstalledTool(name: string): boolean {
  const filePath = join(getCustomToolsDir(), `${name}.tool.ts`);
  if (!existsSync(filePath)) return false;

  const { unlinkSync } = require('node:fs');
  unlinkSync(filePath);

  // Remove from lock file
  const lock = readToolLock();
  delete lock[name];
  writeToolLock(lock);

  logger.info(`Tool removed: ${name}`);
  return true;
}

/**
 * List all installed custom tools from the lock file.
 */
export function listInstalledTools(): ToolLock {
  return readToolLock();
}

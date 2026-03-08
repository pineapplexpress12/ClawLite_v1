#!/usr/bin/env node

// Dev-mode CLI entry point — uses tsx to execute TypeScript directly.
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tsxBin = join(__dirname, '..', 'node_modules', '.bin', 'tsx');
const cliEntry = join(__dirname, '..', 'src', 'cli', 'index.ts');

// Forward all CLI args to the TypeScript entry point via tsx
const args = process.argv.slice(2);

try {
  execFileSync(tsxBin, [cliEntry, ...args], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
} catch (err) {
  // execFileSync throws on non-zero exit — propagate the exit code
  const exitCode = err && typeof err === 'object' && 'status' in err ? err.status : 1;
  process.exit(exitCode || 1);
}

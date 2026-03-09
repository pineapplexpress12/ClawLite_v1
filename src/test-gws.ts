import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

console.log('=== GWS Diagnostic ===\n');

// Test 1: gws version
try {
  const version = execSync('gws --version', { encoding: 'utf-8' }).trim();
  console.log('gws version:', version);
} catch (err) {
  console.log('gws not found:', (err as Error).message);
  process.exit(1);
}

// Test 2: credential files
const home = process.env.HOME || '';
const gwsDir = `${home}/.config/gws`;
console.log('\nCredential files:');
console.log('  ~/.config/gws/ exists:', existsSync(gwsDir));
console.log('  credentials.enc:', existsSync(`${gwsDir}/credentials.enc`));
console.log('  credentials.json:', existsSync(`${gwsDir}/credentials.json`));
console.log('  client_secret.json:', existsSync(`${gwsDir}/client_secret.json`));

// Test 3: gmail list WITH userId=me
console.log('\n--- Test: gws gmail users messages list --params \'{"userId":"me"}\' ---');
const proc = spawn('gws', ['gmail', 'users', 'messages', 'list', '--params', '{"userId":"me"}'], {
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';

proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

proc.on('close', (code) => {
  console.log('Exit code:', code);
  if (stdout) {
    const lines = stdout.trim().split('\n');
    console.log('Lines returned:', lines.length);
    console.log('First line:', lines[0]?.slice(0, 300));
    if (lines.length > 1) console.log('Second line:', lines[1]?.slice(0, 300));
  } else {
    console.log('stdout: (empty)');
  }
  if (stderr) console.log('stderr:', stderr.slice(0, 500));
});

proc.on('error', (err) => {
  console.log('Spawn error:', err.message);
});

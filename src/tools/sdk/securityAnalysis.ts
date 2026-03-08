export interface SecurityIssue {
  severity: 'critical' | 'warning' | 'info';
  code: string;
  message: string;
  file: string;
  line?: number;
  detail?: string;
}

export interface SecurityAnalysisResult {
  score: number;
  passed: boolean;
  criticalIssues: SecurityIssue[];
  warnings: SecurityIssue[];
  info: SecurityIssue[];
  permissions: string[];
  approvalGatedActions: string[];
}

interface PatternCheck {
  pattern: RegExp;
  severity: 'critical' | 'warning' | 'info';
  code: string;
  message: string;
}

const CRITICAL_PATTERNS: PatternCheck[] = [
  { pattern: /child_process\.(exec|execSync|spawn|spawnSync)\s*\(/, severity: 'critical', code: 'EXEC_SHELL', message: 'Shell execution detected (child_process)' },
  { pattern: /\beval\s*\(/, severity: 'critical', code: 'EXEC_SHELL', message: 'eval() detected — arbitrary code execution' },
  { pattern: /new\s+Function\s*\(/, severity: 'critical', code: 'EXEC_SHELL', message: 'new Function() detected — arbitrary code execution' },
  { pattern: /require\s*\(\s*['"]child_process['"]\s*\)/, severity: 'critical', code: 'EXEC_SHELL', message: 'child_process require detected' },
  { pattern: /(['"`])(\/etc\/|\/home\/|~\/\.)/, severity: 'critical', code: 'FS_ESCAPE', message: 'Access to system paths detected' },
  { pattern: /\.ssh/, severity: 'critical', code: 'FS_ESCAPE', message: 'SSH directory access detected' },
  { pattern: /\.env(?!\.example)/, severity: 'critical', code: 'FS_ESCAPE', message: '.env file access detected' },
  { pattern: /credentials/i, severity: 'critical', code: 'FS_ESCAPE', message: 'Credentials file access detected' },
  { pattern: /Buffer\.from\s*\([^)]+,\s*['"]base64['"]\s*\)\.toString/, severity: 'critical', code: 'OBFUSCATED', message: 'Base64-encoded payload detected' },
  { pattern: /atob\s*\(/, severity: 'critical', code: 'OBFUSCATED', message: 'Base64 decoding (atob) detected' },
  { pattern: /\\x[0-9a-f]{2}\\x[0-9a-f]{2}\\x[0-9a-f]{2}/i, severity: 'critical', code: 'OBFUSCATED', message: 'Hex-encoded payload detected' },
  { pattern: /String\.fromCharCode\s*\(\s*\d+\s*(,\s*\d+\s*){5,}\)/, severity: 'critical', code: 'OBFUSCATED', message: 'String.fromCharCode obfuscation detected' },
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, severity: 'critical', code: 'PROMPT_INJECTION', message: 'Prompt injection attempt in tool metadata' },
  { pattern: /you\s+are\s+now\s+/i, severity: 'critical', code: 'PROMPT_INJECTION', message: 'Prompt injection: persona override attempt' },
  { pattern: /system\s*:\s*you/i, severity: 'critical', code: 'PROMPT_INJECTION', message: 'Prompt injection: system prompt override' },
  { pattern: /disregard\s+(the\s+)?(above|previous)/i, severity: 'critical', code: 'PROMPT_INJECTION', message: 'Prompt injection: instruction disregard' },
  { pattern: /override\s+(your|the)\s+(instructions|rules|guidelines)/i, severity: 'critical', code: 'PROMPT_INJECTION', message: 'Prompt injection: instruction override' },
  { pattern: /require\s*\(\s*[^'"]/,  severity: 'critical', code: 'DYNAMIC_LOAD', message: 'Dynamic require() with variable detected' },
  { pattern: /import\s*\(\s*[^'"]/,   severity: 'critical', code: 'DYNAMIC_LOAD', message: 'Dynamic import() with variable detected' },
  { pattern: /vm\.run/,               severity: 'critical', code: 'DYNAMIC_LOAD', message: 'vm.run* detected — sandboxed code execution' },
  { pattern: /WebAssembly\.(instantiate|compile)/, severity: 'critical', code: 'DYNAMIC_LOAD', message: 'WebAssembly loading detected' },
];

const WARNING_PATTERNS: PatternCheck[] = [
  { pattern: /axios|node-fetch|got|undici/, severity: 'warning', code: 'NET_ACCESS', message: 'Network library usage detected' },
  { pattern: /https?\.request\s*\(/, severity: 'warning', code: 'NET_ACCESS', message: 'HTTP request detected' },
  { pattern: /fetch\s*\(\s*['"`]http/, severity: 'warning', code: 'NET_ACCESS', message: 'Fetch API call detected' },
  { pattern: /process\.env/, severity: 'warning', code: 'ENV_READ', message: 'process.env access detected' },
  { pattern: /writeFile|writeFileSync|appendFile|appendFileSync/, severity: 'warning', code: 'FS_WRITE', message: 'Filesystem write detected' },
];

const INFO_PATTERNS: PatternCheck[] = [
  { pattern: /mockHandler/, severity: 'info', code: 'HAS_MOCK', message: 'Tool includes mock handler (dry run support)' },
];

/**
 * Run security analysis on tool source code.
 */
export function analyzeToolSecurity(
  sourceCode: string,
  fileName: string,
  declaredPermissions: string[] = [],
): SecurityAnalysisResult {
  const criticalIssues: SecurityIssue[] = [];
  const warnings: SecurityIssue[] = [];
  const info: SecurityIssue[] = [];

  const lines = sourceCode.split('\n');

  // Run pattern checks
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    for (const check of CRITICAL_PATTERNS) {
      if (check.pattern.test(line)) {
        criticalIssues.push({
          severity: check.severity,
          code: check.code,
          message: check.message,
          file: fileName,
          line: lineNum,
          detail: line.trim(),
        });
      }
    }

    for (const check of WARNING_PATTERNS) {
      if (check.pattern.test(line)) {
        warnings.push({
          severity: check.severity,
          code: check.code,
          message: check.message,
          file: fileName,
          line: lineNum,
          detail: line.trim(),
        });
      }
    }

    for (const check of INFO_PATTERNS) {
      if (check.pattern.test(line)) {
        info.push({
          severity: check.severity,
          code: check.code,
          message: check.message,
          file: fileName,
          line: lineNum,
        });
      }
    }
  }

  // Check for no mock handler
  if (!sourceCode.includes('mockHandler')) {
    info.push({
      severity: 'info',
      code: 'NO_MOCK',
      message: 'Tool does not include a mockHandler — no dry run support',
      file: fileName,
    });
  }

  // Extract hardcoded URLs for review
  const urlPattern = /['"`](https?:\/\/[^'"`\s]+)['"`]/g;
  let match;
  while ((match = urlPattern.exec(sourceCode)) !== null) {
    warnings.push({
      severity: 'warning',
      code: 'OUTBOUND_URLS',
      message: `Outbound URL: ${match[1]}`,
      file: fileName,
      detail: match[0],
    });
  }

  // Calculate score
  let score = 10;
  score -= criticalIssues.length * 3;
  score -= warnings.length * 1;
  score = Math.max(0, Math.min(10, score));

  return {
    score,
    passed: criticalIssues.length === 0,
    criticalIssues,
    warnings,
    info,
    permissions: declaredPermissions,
    approvalGatedActions: [],
  };
}

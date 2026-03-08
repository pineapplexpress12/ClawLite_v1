import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getClawliteHome } from '../db/connection.js';
import { complete } from '../llm/provider.js';
import { analyzeToolSecurity } from '../tools/sdk/securityAnalysis.js';
import type { SecurityAnalysisResult } from '../tools/sdk/securityAnalysis.js';
import { logger } from '../core/logger.js';

export interface GenerateToolRequest {
  name: string;
  apiDescription: string;
  apiBaseUrl?: string;
  actions: { name: string; description: string; risk: string }[];
  authType?: string;
  authEnvVar?: string;
}

export interface GenerateToolResult {
  code: string;
  tempPath: string;
  security: SecurityAnalysisResult;
}

/**
 * Generate a new tool using balanced-tier LLM, then run security analysis.
 * Returns the generated code and security report — caller must present to user for approval.
 */
export async function generateTool(request: GenerateToolRequest): Promise<GenerateToolResult> {
  const prompt = buildToolPrompt(request);

  const result = await complete({
    model: 'balanced',
    messages: [
      {
        role: 'system',
        content: 'You are a TypeScript tool generator for ClawLite. Generate a complete ToolDefinition file. Only output TypeScript code, no markdown fences.',
      },
      { role: 'user', content: prompt },
    ],
  });

  const code = result.text.replace(/^```typescript?\n?/m, '').replace(/\n?```$/m, '').trim();

  // Write to temp location
  const tempPath = join(tmpdir(), `clawlite-tool-${request.name}.tool.ts`);
  writeFileSync(tempPath, code);

  // Run security analysis
  const security = analyzeToolSecurity(code, request.name);

  return { code, tempPath, security };
}

/**
 * Install an approved tool to the custom tools directory.
 */
export function installApprovedTool(name: string, code: string): string {
  const customDir = join(getClawliteHome(), 'tools', 'custom');
  if (!existsSync(customDir)) {
    mkdirSync(customDir, { recursive: true });
  }

  const toolPath = join(customDir, `${name}.tool.ts`);
  writeFileSync(toolPath, code);
  logger.info('Tool installed', { name, path: toolPath });
  return toolPath;
}

/**
 * Clean up temp file after approval/rejection.
 */
export function cleanupTempTool(tempPath: string): void {
  try {
    unlinkSync(tempPath);
  } catch {
    // ignore
  }
}

function buildToolPrompt(request: GenerateToolRequest): string {
  const actions = request.actions
    .map(a => `  - ${a.name}: ${a.description} (risk: ${a.risk})`)
    .join('\n');

  return `Generate a ClawLite tool definition for "${request.name}".

API description: ${request.apiDescription}
${request.apiBaseUrl ? `API base URL: ${request.apiBaseUrl}` : ''}
Auth type: ${request.authType ?? 'api_key'}
Auth env var: ${request.authEnvVar ?? `${request.name.toUpperCase().replace(/-/g, '_')}_API_KEY`}

Actions:
${actions}

The tool must:
1. Export a ToolDefinition object as default export
2. Use Zod schemas for parameter validation
3. Include requiredSecrets array
4. Set appropriate permission levels (read/write/execute)
5. Include approval gates on dangerous actions (create, delete, send, publish)
6. Use axios for HTTP requests
7. Include a mockHandler for dry-run support`;
}

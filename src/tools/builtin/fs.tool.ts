import { z } from 'zod';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { getClawliteHome } from '../../db/connection.js';
import type { ToolDefinition, ToolContext } from '../sdk/types.js';

const schema = z.object({
  action: z.enum(['readText', 'writeText', 'listDir']),
  path: z.string().min(1),
  content: z.string().optional(),
});

function getSandboxRoot(): string {
  return join(getClawliteHome(), 'workspace');
}

function resolveSafePath(userPath: string): string {
  const sandboxRoot = getSandboxRoot();
  const resolved = resolve(sandboxRoot, userPath);
  const rel = relative(sandboxRoot, resolved);

  // Ensure path doesn't escape sandbox
  if (rel.startsWith('..') || resolve(resolved) !== resolved.replace(/\/$/, '')) {
    throw new Error(`Path "${userPath}" escapes the workspace sandbox`);
  }

  if (!resolved.startsWith(sandboxRoot)) {
    throw new Error(`Path "${userPath}" is outside the workspace`);
  }

  return resolved;
}

export const FsTool: ToolDefinition<typeof schema> = {
  name: 'fs',
  description: 'Sandboxed local filesystem operations within .clawlite/workspace/',
  version: '1.0.0',
  permissions: [],
  risk: 'low',
  requiredSecrets: [],
  schema,

  async handler(params) {
    const safePath = resolveSafePath(params.path);

    switch (params.action) {
      case 'readText': {
        if (!existsSync(safePath)) {
          throw new Error(`File not found: ${params.path}`);
        }
        const content = readFileSync(safePath, 'utf-8');
        return { content, path: params.path };
      }

      case 'writeText': {
        if (!params.content) {
          throw new Error('Content is required for writeText action');
        }
        const dir = join(safePath, '..');
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(safePath, params.content, 'utf-8');
        return { written: true, path: params.path, bytes: Buffer.byteLength(params.content) };
      }

      case 'listDir': {
        if (!existsSync(safePath)) {
          throw new Error(`Directory not found: ${params.path}`);
        }
        const entries = readdirSync(safePath).map(name => {
          const fullPath = join(safePath, name);
          const stat = statSync(fullPath);
          return {
            name,
            type: stat.isDirectory() ? 'directory' : 'file',
            size: stat.size,
          };
        });
        return { entries, path: params.path };
      }

      default:
        throw new Error(`Unknown fs action: ${params.action}`);
    }
  },

  async mockHandler(params) {
    return {
      status: 'dry_run',
      action: params.action,
      path: params.path,
    };
  },
};

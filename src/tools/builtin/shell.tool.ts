import { z } from 'zod';
import { execSync } from 'node:child_process';
import type { ToolDefinition, ToolContext } from '../sdk/types.js';

const schema = z.object({
  command: z.string().optional(),
}).passthrough();

export const ShellTool: ToolDefinition<typeof schema> = {
  name: 'shell',
  description: 'Run a shell command on the local machine. Use for file operations (cp, mv, mkdir, cat, ls), installing packages (npm install), or running CLI tools (gws auth login, gws auth setup). Examples: command="cp /path/source /path/dest", command="mkdir -p ~/.config/gws", command="npm install -g @googleworkspace/cli", command="gws auth login"',
  version: '1.0.0',
  permissions: [],
  risk: 'high',
  requiredSecrets: [],
  schema,
  jsonSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute, e.g. "cp /path/from /path/to" or "mkdir -p /path" or "gws auth login"' },
    },
    required: ['command'],
  },

  async handler(params, _ctx: ToolContext) {
    const p = params as Record<string, unknown>;
    const command = (p.command ?? p.cmd ?? p.shell ?? p.exec) as string | undefined;

    if (!command || typeof command !== 'string') {
      return { error: 'command parameter is required. Example: command="ls -la"' };
    }

    // Block dangerous commands
    const blocked = ['rm -rf /', 'mkfs', 'dd if=', ':(){', 'fork bomb'];
    if (blocked.some(b => command.includes(b))) {
      return { error: 'Command blocked for safety.' };
    }

    try {
      const output = execSync(command, {
        timeout: 60000,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { success: true, output: output.trim().slice(0, 2000) };
    } catch (err: unknown) {
      const e = err as { stderr?: { toString(): string }; stdout?: { toString(): string }; message: string };
      return {
        success: false,
        error: e.stderr?.toString().trim() || e.message,
        output: e.stdout?.toString().trim().slice(0, 2000) || '',
      };
    }
  },

  async mockHandler(params) {
    return { status: 'dry_run', command: (params as Record<string, unknown>).command };
  },
};

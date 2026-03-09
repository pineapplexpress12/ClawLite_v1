import { z } from 'zod';
import { spawn } from 'node:child_process';
import type { ToolDefinition, ToolContext } from '../sdk/types.js';

const schema = z.object({
  action: z.enum([
    'gmail.list', 'gmail.get', 'gmail.draft.create', 'gmail.send',
    'calendar.list', 'calendar.create',
    'drive.list', 'drive.upload', 'drive.share_external',
  ]),
  params: z.record(z.unknown()).default({}),
});

const PERMISSION_MAP: Record<string, string> = {
  'gmail.list': 'workspace.gmail.read',
  'gmail.get': 'workspace.gmail.read',
  'gmail.draft.create': 'workspace.gmail.draft',
  'gmail.send': 'workspace.gmail.send',
  'calendar.list': 'workspace.calendar.read',
  'calendar.create': 'workspace.calendar.write',
  'drive.list': 'workspace.drive.read',
  'drive.upload': 'workspace.drive.write',
  'drive.share_external': 'workspace.drive.share_external',
};

function buildGwsArgs(action: string, params: Record<string, unknown>): string[] {
  const args: string[] = [];

  switch (action) {
    case 'gmail.list':
      args.push('gmail', 'users', 'messages', 'list');
      if (Object.keys(params).length > 0) {
        args.push('--params', JSON.stringify(params));
      }
      break;
    case 'gmail.get':
      args.push('gmail', 'users', 'messages', 'get');
      if (Object.keys(params).length > 0) {
        args.push('--params', JSON.stringify(params));
      }
      break;
    case 'gmail.draft.create':
      args.push('gmail', 'users', 'drafts', 'create');
      if (params.raw) {
        args.push('--json', JSON.stringify({ message: { raw: params.raw } }));
      } else if (Object.keys(params).length > 0) {
        args.push('--params', JSON.stringify(params));
      }
      break;
    case 'gmail.send':
      args.push('gmail', 'users', 'messages', 'send');
      if (params.raw) {
        args.push('--json', JSON.stringify({ raw: params.raw }));
      } else if (Object.keys(params).length > 0) {
        args.push('--json', JSON.stringify(params));
      }
      break;
    case 'calendar.list':
      args.push('calendar', 'events', 'list', '--page-all');
      if (Object.keys(params).length > 0) {
        args.push('--params', JSON.stringify(params));
      }
      break;
    case 'calendar.create':
      args.push('calendar', 'events', 'insert');
      if (Object.keys(params).length > 0) {
        args.push('--json', JSON.stringify(params));
      }
      break;
    case 'drive.list':
      args.push('drive', 'files', 'list', '--page-all');
      if (Object.keys(params).length > 0) {
        args.push('--params', JSON.stringify(params));
      }
      break;
    case 'drive.upload':
      args.push('drive', 'files', 'create');
      if (Object.keys(params).length > 0) {
        args.push('--params', JSON.stringify(params));
      }
      break;
    case 'drive.share_external':
      args.push('drive', 'permissions', 'create');
      if (Object.keys(params).length > 0) {
        args.push('--params', JSON.stringify(params));
      }
      break;
    default: {
      const parts = action.split('.');
      args.push(...parts);
      if (Object.keys(params).length > 0) {
        args.push('--params', JSON.stringify(params));
      }
    }
  }

  return args;
}

async function runGwsCommand(args: string[]): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    console.log('[GWS CMD]', 'gws', args.join(' '));

    const proc = spawn('gws', args, {
      env: { ...process.env },
    });

    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];

    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => errors.push(chunk));

    proc.on('close', (code) => {
      const rawStdout = Buffer.concat(chunks).toString().trim();
      const rawStderr = Buffer.concat(errors).toString().trim();

      console.log('[GWS STDOUT]', rawStdout.slice(0, 500));
      if (rawStderr) console.log('[GWS STDERR]', rawStderr.slice(0, 500));

      if (code !== 0) {
        return reject(new Error(rawStderr || `gws exited with code ${code}`));
      }

      if (!rawStdout) return resolve([]);

      const lines = rawStdout.split('\n').filter(Boolean);
      try {
        const parsed = lines.map(line => JSON.parse(line));
        resolve(parsed);
      } catch {
        try {
          resolve([JSON.parse(rawStdout)]);
        } catch {
          resolve([{ raw: rawStdout }]);
        }
      }
    });

    proc.on('error', (err) => reject(err));
  });
}

export const WorkspaceTool: ToolDefinition<typeof schema> = {
  name: 'workspace',
  description: 'Google Workspace integration (Gmail, Calendar, Drive) via gws CLI',
  version: '1.0.0',
  permissions: [
    'workspace.gmail.read', 'workspace.gmail.draft', 'workspace.gmail.send',
    'workspace.calendar.read', 'workspace.calendar.write',
    'workspace.drive.read', 'workspace.drive.write', 'workspace.drive.share_external',
  ],
  risk: 'high',
  requiredSecrets: [],
  schema,
  jsonSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['gmail.list', 'gmail.get', 'gmail.draft.create', 'gmail.send', 'calendar.list', 'calendar.create', 'drive.list', 'drive.upload', 'drive.share_external'],
        description: 'The workspace action to perform',
      },
      params: {
        type: 'object',
        description: 'Additional parameters for the action',
      },
    },
    required: ['action'],
  },

  async handler(params, ctx: ToolContext) {
    const { execSync } = await import('node:child_process');
    try {
      execSync('gws --version', { stdio: 'ignore' });
    } catch {
      return {
        status: 'not_connected',
        error: 'Google Workspace CLI (gws) is not installed or not authenticated.',
        action: 'Use the gws_connect tool to set up Google Workspace.',
      };
    }

    const requiredPerm = PERMISSION_MAP[params.action];
    if (requiredPerm && !ctx.policy.allowPermissions.includes(requiredPerm)) {
      return { status: 'blocked', reason: 'permission_denied', missingPermission: requiredPerm };
    }

    try {
      const args = buildGwsArgs(params.action, params.params);
      const result = await runGwsCommand(args);
      return { data: result };
    } catch (err) {
      const errMsg = (err as Error).message;
      console.log('[WORKSPACE ERROR]', errMsg);

      if (errMsg.includes('auth') || errMsg.includes('credential') || errMsg.includes('token') || errMsg.includes('ENOENT')) {
        return {
          status: 'not_connected',
          error: 'Google Workspace authentication failed or expired.',
          action: 'Use the gws_connect tool to reconnect.',
        };
      }

      return { error: errMsg };
    }
  },

  async mockHandler(params) {
    return {
      status: 'dry_run',
      action: params.action,
      wouldExecute: `gws ${params.action}`,
      mockData: [{ id: 'mock-1', subject: 'Mock result' }],
    };
  },
};

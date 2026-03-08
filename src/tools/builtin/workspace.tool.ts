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

const APPROVAL_REQUIRED = new Set([
  'gmail.send', 'calendar.create', 'drive.share_external',
]);

function buildGwsArgs(action: string, params: Record<string, unknown>): string[] {
  const parts = action.split('.');
  const args: string[] = [];

  // Map actions to gws CLI args
  switch (action) {
    case 'gmail.list':
      args.push('gmail', 'users', 'messages', 'list', '--page-all');
      break;
    case 'gmail.get':
      args.push('gmail', 'users', 'messages', 'get');
      break;
    case 'gmail.draft.create':
      args.push('gmail', 'users', 'drafts', 'create');
      break;
    case 'gmail.send':
      args.push('gmail', 'users', 'messages', 'send');
      break;
    case 'calendar.list':
      args.push('calendar', 'events', 'list', '--page-all');
      break;
    case 'calendar.create':
      args.push('calendar', 'events', 'insert');
      break;
    case 'drive.list':
      args.push('drive', 'files', 'list', '--page-all');
      break;
    case 'drive.upload':
      args.push('drive', 'files', 'create');
      break;
    case 'drive.share_external':
      args.push('drive', 'permissions', 'create');
      break;
    default:
      args.push(...parts);
  }

  if (Object.keys(params).length > 0) {
    args.push('--params', JSON.stringify(params));
  }

  return args;
}

async function runGwsCommand(args: string[], credentialsPath: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn('gws', args, {
      env: {
        ...process.env,
        GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: credentialsPath,
      },
    });

    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];

    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => errors.push(chunk));

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(Buffer.concat(errors).toString().trim()));
      }

      // gws --page-all returns NDJSON (one JSON object per line)
      const raw = Buffer.concat(chunks).toString().trim();
      if (!raw) return resolve([]);

      const lines = raw.split('\n').filter(Boolean);
      try {
        const parsed = lines.map(line => JSON.parse(line));
        resolve(parsed);
      } catch {
        try {
          resolve([JSON.parse(raw)]);
        } catch {
          resolve([{ raw }]);
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
  requiredSecrets: [
    { envVar: 'GWS_CREDENTIALS_PATH', description: 'Path to Google Workspace CLI credentials JSON' },
  ],
  schema,

  async handler(params, ctx: ToolContext) {
    const requiredPerm = PERMISSION_MAP[params.action];
    if (requiredPerm && !ctx.policy.allowPermissions.includes(requiredPerm)) {
      return { status: 'blocked', reason: 'permission_denied', missingPermission: requiredPerm };
    }

    // Check approval requirement
    if (APPROVAL_REQUIRED.has(params.action)) {
      const { approvalId } = await ctx.approvals.request({
        actionType: params.action,
        title: `Execute ${params.action}`,
        preview: JSON.stringify(params.params, null, 2),
        data: params,
      });
      return { status: 'waiting_approval', approvalId };
    }

    const credentialsPath = ctx.secrets.get('GWS_CREDENTIALS_PATH');
    if (!credentialsPath) {
      throw new Error('GWS_CREDENTIALS_PATH not configured');
    }

    const args = buildGwsArgs(params.action, params.params);
    const result = await runGwsCommand(args, credentialsPath);
    return { data: result };
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

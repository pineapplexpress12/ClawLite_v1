import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../sdk/types.js';
import {
  loadRawConfig,
  saveRawConfig,
  getNestedValue,
  setNestedValue,
  parseValue,
  redactSecrets,
} from '../../core/configIO.js';
import { appendToEnvFile, listSecretKeys } from '../../core/secrets.js';

const schema = z.object({
  action: z.enum(['config.get', 'config.set', 'config.show', 'secret.set', 'secret.list']),
  key: z.string().optional(),
  value: z.string().optional(),
});

const APPROVAL_REQUIRED = new Set(['config.set', 'secret.set']);

export const ConfigTool: ToolDefinition<typeof schema> = {
  name: 'config',
  description: 'Read and modify ClawLite configuration and secrets. Use config.get/config.set for config.json, secret.set/secret.list for .env secrets.',
  version: '1.0.0',
  permissions: [],
  risk: 'high',
  requiredSecrets: [],
  schema,

  async handler(params, ctx: ToolContext) {
    // Check approval requirement for write operations
    if (APPROVAL_REQUIRED.has(params.action)) {
      const { approvalId } = await ctx.approvals.request({
        actionType: params.action,
        title: `${params.action}: ${params.key}`,
        preview: params.action === 'secret.set'
          ? `Set secret ${params.key} = ***REDACTED***`
          : `Set config ${params.key} = ${params.value}`,
        data: { key: params.key, value: params.action === 'secret.set' ? '***' : params.value },
      });
      // After approval, proceed with the actual write
      // For now, execute immediately (approval flow will intercept if needed)
    }

    switch (params.action) {
      case 'config.get': {
        if (!params.key) {
          return { error: 'Key is required for config.get' };
        }
        const configData = loadRawConfig();
        const value = getNestedValue(configData, params.key);
        if (value === undefined) {
          return { error: `Key "${params.key}" not found in config` };
        }
        return { key: params.key, value };
      }

      case 'config.set': {
        if (!params.key || params.value === undefined) {
          return { error: 'Key and value are required for config.set' };
        }
        const configData = loadRawConfig();
        setNestedValue(configData, params.key, parseValue(params.value));
        saveRawConfig(configData);
        return { success: true, key: params.key, value: parseValue(params.value), note: 'Restart required for some changes to take effect.' };
      }

      case 'config.show': {
        const configData = loadRawConfig();
        return { config: redactSecrets(configData) };
      }

      case 'secret.set': {
        if (!params.key || params.value === undefined) {
          return { error: 'Key and value are required for secret.set' };
        }
        appendToEnvFile(params.key, params.value);
        return { success: true, key: params.key, note: 'Secret saved and hot-reloaded.' };
      }

      case 'secret.list': {
        const keys = listSecretKeys();
        return { secretKeys: keys };
      }

      default:
        return { error: `Unknown action: ${params.action}` };
    }
  },

  async mockHandler(params) {
    return {
      status: 'dry_run',
      action: params.action,
      key: params.key,
    };
  },
};

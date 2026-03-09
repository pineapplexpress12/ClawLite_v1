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

/** Flatten a nested object into dot-notation keys */
function flattenObject(obj: Record<string, any>, prefix = ''): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(result, flattenObject(v, newKey));
    } else {
      result[newKey] = v;
    }
  }
  return result;
}

// --- config_get ---
const getSchema = z.object({
  key: z.string().optional().describe('Dot-notation config path, e.g. "llm.tiers.strong"'),
}).passthrough();

export const ConfigGetTool: ToolDefinition<typeof getSchema> = {
  name: 'config_get',
  description: 'Read a value from ClawLite config.json. Pass key parameter. Example: key="llm.tiers.strong"',
  version: '1.0.0',
  permissions: [],
  risk: 'low',
  requiredSecrets: [],
  schema: getSchema,
  jsonSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Dot-notation config path, e.g. "llm.tiers.strong"' },
    },
    required: ['key'],
  },

  async handler(params, ctx: ToolContext) {
    const p = params as Record<string, any>;
    const key = p.key ?? p.path ?? p.setting ?? p.config_key ?? p.name;
    console.log('[CONFIG_GET DEBUG] raw:', JSON.stringify(params), 'key:', key);
    if (!key) return { error: 'key is required. Example: key="llm.tiers.strong"' };
    const configData = loadRawConfig();
    const value = getNestedValue(configData, String(key));
    if (value === undefined) return { error: `Key "${key}" not found` };
    return { key, value };
  },

  async mockHandler(params) { return { status: 'dry_run', params }; },
};

// --- config_set ---
const setSchema = z.object({
  key: z.string().optional().describe('Dot-notation config path, e.g. "llm.tiers.strong"'),
  value: z.string().optional().describe('New value, e.g. "anthropic/claude-opus-4.6"'),
}).passthrough();

export const ConfigSetTool: ToolDefinition<typeof setSchema> = {
  name: 'config_set',
  description: 'Write a value to ClawLite config.json. Pass key and value parameters. Example: key="llm.tiers.strong", value="anthropic/claude-opus-4.6"',
  version: '1.0.0',
  permissions: [],
  risk: 'medium',
  requiredSecrets: [],
  schema: setSchema,
  jsonSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Dot-notation config path, e.g. "llm.tiers.strong"' },
      value: { type: 'string', description: 'New value, e.g. "anthropic/claude-opus-4.6"' },
    },
    required: ['key', 'value'],
  },

  async handler(params, ctx: ToolContext) {
    const p = params as Record<string, any>;
    console.log('[CONFIG_SET DEBUG] raw:', JSON.stringify(params));

    let key = p.key ?? p.path ?? p.setting ?? p.config_key ?? p.name ?? p.property;
    let value = p.value ?? p.new_value ?? p.config_value ?? p.model ?? p.model_id;

    // Handle nested: { llm: { tiers: { strong: "..." } } }
    if (!key && !value) {
      const flat = flattenObject(p);
      if (Object.keys(flat).length >= 1) {
        const [k, v] = Object.entries(flat)[0];
        key = k;
        value = String(v);
      }
    }

    // Handle: { "llm.tiers.strong": "anthropic/claude-opus-4.6" }
    if (!key && !value) {
      for (const [k, v] of Object.entries(p)) {
        if (k.includes('.') && typeof v === 'string') {
          key = k; value = v; break;
        }
      }
    }

    console.log('[CONFIG_SET DEBUG] normalized: key=' + key + ' value=' + value);
    if (!key || value === undefined) {
      return { error: 'key and value required. Example: key="llm.tiers.strong", value="anthropic/claude-opus-4.6"' };
    }

    const configData = loadRawConfig();
    setNestedValue(configData, String(key), parseValue(String(value)));
    saveRawConfig(configData);
    return { success: true, key, value: parseValue(String(value)), note: 'Config updated. Restart may be needed.' };
  },

  async mockHandler(params) { return { status: 'dry_run', params }; },
};

// --- config_show ---
const showSchema = z.object({});

export const ConfigShowTool: ToolDefinition<typeof showSchema> = {
  name: 'config_show',
  description: 'Show the full ClawLite configuration (secrets redacted).',
  version: '1.0.0',
  permissions: [],
  risk: 'low',
  requiredSecrets: [],
  schema: showSchema,
  jsonSchema: {
    type: 'object',
    properties: {},
  },

  async handler(params, ctx: ToolContext) {
    const configData = loadRawConfig();
    return { config: redactSecrets(configData) };
  },

  async mockHandler() {
    return { status: 'dry_run', action: 'config.show' };
  },
};

// --- secret_set ---
const secretSetSchema = z.object({
  key: z.string().describe('Environment variable name, e.g. "OPENROUTER_API_KEY"'),
  value: z.string().describe('Secret value'),
});

export const SecretSetTool: ToolDefinition<typeof secretSetSchema> = {
  name: 'secret_set',
  description: 'Add or update a secret in .clawlite/.env. Example: key="STRIPE_KEY", value="sk_live_..."',
  version: '1.0.0',
  permissions: [],
  risk: 'high',
  requiredSecrets: [],
  schema: secretSetSchema,
  jsonSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Environment variable name, e.g. "OPENROUTER_API_KEY"' },
      value: { type: 'string', description: 'Secret value' },
    },
    required: ['key', 'value'],
  },

  async handler(params, ctx: ToolContext) {
    const { approvalId } = await ctx.approvals.request({
      actionType: 'secret.set',
      title: `Set secret: ${params.key}`,
      preview: `Set ${params.key} = ***REDACTED***`,
      data: { key: params.key },
    });
    appendToEnvFile(params.key, params.value);
    return { success: true, key: params.key, note: 'Secret saved.' };
  },

  async mockHandler(params) {
    return { status: 'dry_run', key: params.key };
  },
};

// --- secret_list ---
const secretListSchema = z.object({});

export const SecretListTool: ToolDefinition<typeof secretListSchema> = {
  name: 'secret_list',
  description: 'List all configured secret key names from .clawlite/.env (values not shown).',
  version: '1.0.0',
  permissions: [],
  risk: 'low',
  requiredSecrets: [],
  schema: secretListSchema,
  jsonSchema: {
    type: 'object',
    properties: {},
  },

  async handler(params, ctx: ToolContext) {
    return { secretKeys: listSecretKeys() };
  },

  async mockHandler() {
    return { status: 'dry_run' };
  },
};

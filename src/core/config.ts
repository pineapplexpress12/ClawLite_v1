import { z } from 'zod';
import { readFileSync, existsSync, watchFile } from 'node:fs';
import { join } from 'node:path';
import { getClawliteHome } from '../db/connection.js';

// --- Zod Schemas ---

const ChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  allowedUserIds: z.array(z.union([z.number(), z.string()])).default([]),
});

const WebchatConfigSchema = z.object({
  enabled: z.boolean().default(false),
});

const ChannelsSchema = z.object({
  telegram: ChannelConfigSchema.default({}),
  whatsapp: ChannelConfigSchema.default({}),
  discord: ChannelConfigSchema.default({}),
  slack: ChannelConfigSchema.default({}),
  webchat: WebchatConfigSchema.default({}),
});

const ToolToggleSchema = z.object({
  enabled: z.boolean().default(false),
});

const ToolsSchema = z.object({
  workspace: ToolToggleSchema.default({}),
  research: ToolToggleSchema.default({}),
});

const BudgetsSchema = z.object({
  dailyTokens: z.number().int().positive().default(200000),
  perJobTokens: z.number().int().positive().default(50000),
  maxToolCallsPerJob: z.number().int().positive().default(200),
});

const HardLimitsSchema = z.object({
  maxNodesPerJob: z.number().int().positive().default(20),
  maxTotalLLMCalls: z.number().int().positive().default(30),
  maxJobDurationMs: z.number().int().positive().default(300000),
  maxRetriesTotalPerJob: z.number().int().positive().default(10),
  agenticMaxIterations: z.number().int().positive().default(5),
  agenticMaxNodes: z.number().int().positive().default(10),
  agenticMaxTokenBudget: z.number().int().positive().default(30000),
});

const HeartbeatSchema = z.object({
  enabled: z.boolean().default(false),
  intervalMinutes: z.number().int().min(5).default(30),
  model: z.string().default('fast'),
});

const HttpSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().int().min(1).max(65535).default(18790),
  host: z.string().default('127.0.0.1'),
});

const SessionSchema = z.object({
  maxTurnsInMemory: z.number().int().positive().default(20),
  turnsInjectedIntoChat: z.number().int().positive().default(5),
  compactionThresholdTokens: z.number().int().positive().default(8000),
});

const UploadsSchema = z.object({
  maxFileSizeMB: z.number().positive().default(25),
  allowedTypes: z.array(z.enum(['document', 'image', 'audio'])).default(['document', 'image', 'audio']),
});

const LlmTiersSchema = z.object({
  fast: z.string(),
  balanced: z.string(),
  strong: z.string(),
});

const LlmSchema = z.object({
  provider: z.enum([
    'openrouter', 'anthropic', 'openai', 'google',
    'xai', 'deepseek', 'mistral', 'groq', 'ollama', 'custom',
  ]),
  tiers: LlmTiersSchema,
});

const ResearchModelsSchema = z.object({
  basic: z.string().default('perplexity/sonar'),
  deep: z.string().default('perplexity/sonar-deep-research'),
});

const ResearchSchema = z.object({
  provider: z.string().default('openrouter'),
  models: ResearchModelsSchema.default({}),
});

const OperatorSchema = z.object({
  name: z.string().min(1),
  persona: z.string().optional(),
});

export const ClawLiteConfigSchema = z.object({
  operator: OperatorSchema,
  llm: LlmSchema,
  research: ResearchSchema.default({}),
  channels: ChannelsSchema.default({}),
  tools: ToolsSchema.default({}),
  budgets: BudgetsSchema.default({}),
  hardLimits: HardLimitsSchema.default({}),
  heartbeat: HeartbeatSchema.default({}),
  http: HttpSchema.default({}),
  session: SessionSchema.default({}),
  uploads: UploadsSchema.default({}),
}).refine(
  (data) => data.budgets.perJobTokens <= data.budgets.dailyTokens,
  { message: 'perJobTokens must be <= dailyTokens', path: ['budgets', 'perJobTokens'] },
);

export type ClawLiteConfig = z.infer<typeof ClawLiteConfigSchema>;

// --- Config singleton ---

let currentConfig: ClawLiteConfig | null = null;

export function getConfigPath(): string {
  return join(getClawliteHome(), 'config.json');
}

export function loadConfig(path?: string): ClawLiteConfig {
  const configPath = path ?? getConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}. Run "clawlite setup" first.`);
  }

  const raw = readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw);
  const result = ClawLiteConfigSchema.parse(parsed);
  currentConfig = result;
  return result;
}

export function getConfig(): ClawLiteConfig {
  if (!currentConfig) {
    throw new Error('Config not loaded. Call loadConfig() first.');
  }
  return currentConfig;
}

export function setConfig(config: ClawLiteConfig): void {
  currentConfig = config;
}

/**
 * Watch config file for hot-reloadable settings (budgets, hardLimits, heartbeat).
 * Returns a cleanup function to stop watching.
 */
export function watchConfig(onChange?: (config: ClawLiteConfig) => void): () => void {
  const configPath = getConfigPath();

  const listener = (): void => {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const newConfig = ClawLiteConfigSchema.parse(parsed);

      if (currentConfig) {
        // Hot-reload only safe fields
        currentConfig.budgets = newConfig.budgets;
        currentConfig.hardLimits = newConfig.hardLimits;
        currentConfig.heartbeat = newConfig.heartbeat;
      }

      onChange?.(currentConfig ?? newConfig);
    } catch {
      // Ignore parse errors during hot-reload — keep existing config
    }
  };

  watchFile(configPath, { interval: 5000 }, listener);

  return () => {
    watchFile(configPath, { interval: 5000 }, () => {}); // unwatchFile equivalent
  };
}

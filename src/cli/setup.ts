import type { Command } from 'commander';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// ─── Readline helpers ────────────────────────────────────────────────

function createRl(): ReadlineInterface {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl: ReadlineInterface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function askDefault(rl: ReadlineInterface, question: string, defaultVal: string): Promise<string> {
  const answer = await ask(rl, `${question} [${defaultVal}]: `);
  return answer || defaultVal;
}

async function askYesNo(rl: ReadlineInterface, question: string, defaultYes: boolean): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = await ask(rl, `${question} [${hint}]: `);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith('y');
}

async function askChoice(rl: ReadlineInterface, prompt: string, options: { label: string; value: string }[], allowFreeform = false): Promise<string> {
  console.log(prompt);
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${i + 1}. ${options[i]!.label}`);
  }
  if (allowFreeform) {
    console.log('  (or type a custom model name)');
  }
  const answer = await ask(rl, '> ');
  if (!answer) return options[0]!.value;
  const idx = parseInt(answer, 10) - 1;
  if (idx >= 0 && idx < options.length) return options[idx]!.value;
  // If freeform is allowed and the input isn't a valid number, use it as-is
  if (allowFreeform && answer.length > 0) return answer;
  return options[0]!.value;
}

/**
 * Parse a number from user input, stripping non-numeric chars
 * (handles European-style "1.000.000" and "1,000,000").
 */
function parseNumberInput(input: string): number {
  // Strip everything except digits
  const cleaned = input.replace(/[^0-9]/g, '');
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? 0 : num;
}

async function askMultiLine(rl: ReadlineInterface, prompt: string): Promise<string[]> {
  console.log(prompt);
  const lines: string[] = [];
  while (true) {
    const line = await ask(rl, '  > ');
    if (!line) break;
    lines.push(line);
  }
  return lines;
}

// ─── Provider model suggestions ─────────────────────────────────────

interface ModelSuggestion {
  model: string;
  cost: string;
  provider: string;
  description: string;
}

const PROVIDER_MODELS: Record<string, { fast: ModelSuggestion[]; balanced: ModelSuggestion[]; strong: ModelSuggestion[] }> = {
  openrouter: {
    fast: [
      { model: 'openai/gpt-4o-mini', cost: '$0.15/$0.60 per M tokens', provider: 'OpenAI', description: 'great value' },
      { model: 'google/gemini-2.0-flash-exp:free', cost: 'FREE', provider: 'Google', description: 'free tier' },
      { model: 'anthropic/claude-haiku-4-5-20251001', cost: '$1/$5 per M tokens', provider: 'Anthropic', description: 'reliable' },
      { model: 'deepseek/deepseek-chat', cost: '$0.14/$0.28 per M tokens', provider: 'DeepSeek', description: 'cheapest' },
    ],
    balanced: [
      { model: 'anthropic/claude-sonnet-4-20250514', cost: '$3/$15 per M tokens', provider: 'Anthropic', description: 'best all-rounder' },
      { model: 'openai/gpt-4o', cost: '$2.50/$10 per M tokens', provider: 'OpenAI', description: 'strong reasoning' },
      { model: 'google/gemini-2.5-pro-preview-06-05', cost: '$1.25/$10 per M tokens', provider: 'Google', description: 'great value' },
    ],
    strong: [
      { model: 'anthropic/claude-opus-4-20250514', cost: '$15/$75 per M tokens', provider: 'Anthropic', description: 'top scores' },
      { model: 'openai/o3', cost: '$10/$40 per M tokens', provider: 'OpenAI', description: 'max capability' },
      { model: 'deepseek/deepseek-r1', cost: '$0.55/$2.19 per M tokens', provider: 'DeepSeek', description: 'best value reasoning' },
    ],
  },
  anthropic: {
    fast: [{ model: 'claude-haiku-4-5-20251001', cost: '$1/$5 per M tokens', provider: 'Anthropic', description: 'fast and reliable' }],
    balanced: [{ model: 'claude-sonnet-4-20250514', cost: '$3/$15 per M tokens', provider: 'Anthropic', description: 'best all-rounder' }],
    strong: [{ model: 'claude-opus-4-20250514', cost: '$15/$75 per M tokens', provider: 'Anthropic', description: 'top reasoning' }],
  },
  openai: {
    fast: [
      { model: 'gpt-4o-mini', cost: '$0.15/$0.60 per M tokens', provider: 'OpenAI', description: 'great value' },
    ],
    balanced: [
      { model: 'gpt-4o', cost: '$2.50/$10 per M tokens', provider: 'OpenAI', description: 'strong reasoning' },
    ],
    strong: [
      { model: 'o3', cost: '$10/$40 per M tokens', provider: 'OpenAI', description: 'maximum capability' },
    ],
  },
  google: {
    fast: [{ model: 'gemini-2.0-flash', cost: '$0.10/$0.40 per M tokens', provider: 'Google', description: 'fast + cheap' }],
    balanced: [{ model: 'gemini-2.5-pro', cost: '$1.25/$10 per M tokens', provider: 'Google', description: 'competitive' }],
    strong: [{ model: 'gemini-2.5-pro', cost: '$1.25/$10 per M tokens', provider: 'Google', description: 'strong + affordable' }],
  },
  xai: {
    fast: [{ model: 'grok-2', cost: '$2/$10 per M tokens', provider: 'xAI', description: '2M context' }],
    balanced: [{ model: 'grok-2', cost: '$2/$10 per M tokens', provider: 'xAI', description: 'strong reasoning' }],
    strong: [{ model: 'grok-2', cost: '$2/$10 per M tokens', provider: 'xAI', description: 'max xAI' }],
  },
  deepseek: {
    fast: [{ model: 'deepseek-chat', cost: '$0.14/$0.28 per M tokens', provider: 'DeepSeek', description: 'ultra-cheap' }],
    balanced: [{ model: 'deepseek-chat', cost: '$0.14/$0.28 per M tokens', provider: 'DeepSeek', description: 'great value' }],
    strong: [{ model: 'deepseek-reasoner', cost: '$0.55/$2.19 per M tokens', provider: 'DeepSeek', description: 'best value reasoning' }],
  },
  mistral: {
    fast: [{ model: 'mistral-small-latest', cost: '$0.10/$0.30 per M tokens', provider: 'Mistral', description: 'fast' }],
    balanced: [{ model: 'mistral-large-latest', cost: '$2/$6 per M tokens', provider: 'Mistral', description: 'strong' }],
    strong: [{ model: 'mistral-large-latest', cost: '$2/$6 per M tokens', provider: 'Mistral', description: 'strongest' }],
  },
  groq: {
    fast: [{ model: 'llama-3.3-70b-versatile', cost: '$0.59/$0.79 per M tokens', provider: 'Groq', description: 'ultra-fast' }],
    balanced: [{ model: 'llama-3.3-70b-versatile', cost: '$0.59/$0.79 per M tokens', provider: 'Groq', description: 'fast inference' }],
    strong: [{ model: 'llama-3.3-70b-versatile', cost: '$0.59/$0.79 per M tokens', provider: 'Groq', description: 'best Groq' }],
  },
  ollama: {
    fast: [{ model: 'llama3.2:3b', cost: 'FREE (local)', provider: 'Ollama', description: 'lightweight local' }],
    balanced: [{ model: 'llama3.1:8b', cost: 'FREE (local)', provider: 'Ollama', description: 'local 8B' }],
    strong: [{ model: 'llama3.1:70b', cost: 'FREE (local)', provider: 'Ollama', description: 'local 70B' }],
  },
  custom: {
    fast: [{ model: 'custom-fast', cost: 'varies', provider: 'Custom', description: 'your fast model' }],
    balanced: [{ model: 'custom-balanced', cost: 'varies', provider: 'Custom', description: 'your balanced model' }],
    strong: [{ model: 'custom-strong', cost: 'varies', provider: 'Custom', description: 'your strong model' }],
  },
};

const PROVIDER_API_KEY_NAMES: Record<string, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_AI_API_KEY',
  xai: 'XAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  groq: 'GROQ_API_KEY',
};

// ─── Step implementations ────────────────────────────────────────────

async function step1_operatorIdentity(rl: ReadlineInterface): Promise<{ name: string; persona: string }> {
  console.log('\n--- Step 1: Operator Identity ---\n');
  const name = await askDefault(rl, 'What should your operator be called?', 'Harri');
  const persona = await askDefault(
    rl,
    'Describe your operator\'s personality',
    `You are ${name}, an AI operator. You are direct, efficient, and transparent.`,
  );
  console.log(`\nOperator: ${name}`);
  console.log('(Tip: You can customize further by editing .clawlite/PERSONA.md later.)');
  return { name, persona };
}

async function step2_llmProvider(rl: ReadlineInterface): Promise<{ provider: string; apiKey: string }> {
  console.log('\n--- Step 2: LLM Provider ---\n');

  const provider = await askChoice(rl, 'Choose your LLM provider:', [
    { label: 'OpenRouter        (recommended — access to 200+ models with one API key)', value: 'openrouter' },
    { label: 'Anthropic         (Claude Opus, Sonnet, Haiku)', value: 'anthropic' },
    { label: 'OpenAI            (GPT-4o, o3, GPT-4o-mini)', value: 'openai' },
    { label: 'Google AI Studio  (Gemini 2.5 Pro/Flash)', value: 'google' },
  ]);

  let apiKey = '';
  if (provider !== 'ollama') {
    const keyName = PROVIDER_API_KEY_NAMES[provider] ?? `${provider.toUpperCase()}_API_KEY`;
    apiKey = await ask(rl, `\nEnter your ${provider} API key: `);
    if (!apiKey) {
      console.log('Warning: No API key provided. You can add it later in .clawlite/.env');
    } else {
      console.log(`API key saved as ${keyName}`);
    }
  } else {
    console.log('Ollama runs locally — no API key needed.');
    console.log('Make sure Ollama is running: ollama serve');
  }

  return { provider, apiKey };
}

async function step3_modelTiers(
  rl: ReadlineInterface,
  provider: string,
): Promise<{ fast: string; balanced: string; strong: string }> {
  console.log('\n--- Step 3: Model Selection ---\n');
  console.log('ClawLite uses 3 model tiers to control costs.');
  console.log('~70% of calls use FAST (cheap), ~25% BALANCED, ~5% STRONG.\n');

  const models = PROVIDER_MODELS[provider] ?? PROVIDER_MODELS['openrouter']!;

  async function pickTier(tierName: string, suggestions: ModelSuggestion[]): Promise<string> {
    console.log(`\n${tierName.toUpperCase()} tier:`);
    const options = suggestions.map((s) => ({
      label: `${s.model.padEnd(45)} ${s.cost.padEnd(30)} — ${s.description}`,
      value: s.model,
    }));
    return askChoice(rl, `  Suggested models:`, options, true);
  }

  const fast = await pickTier('fast', models.fast);
  const balanced = await pickTier('balanced', models.balanced);
  const strong = await pickTier('strong', models.strong);

  console.log(`\nModel tiers configured:`);
  console.log(`  fast:     ${fast}`);
  console.log(`  balanced: ${balanced}`);
  console.log(`  strong:   ${strong}`);

  return { fast, balanced, strong };
}

interface ChannelConfig {
  telegram: { enabled: boolean; allowedUserIds: string[] };
  whatsapp: { enabled: boolean };
  discord: { enabled: boolean; allowedUserIds: string[] };
  slack: { enabled: boolean; allowedUserIds: string[] };
  webchat: { enabled: boolean };
}

interface ChannelSecrets {
  TELEGRAM_BOT_TOKEN?: string;
  DISCORD_BOT_TOKEN?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_APP_TOKEN?: string;
}

async function step4_channels(
  rl: ReadlineInterface,
): Promise<{ channels: ChannelConfig; secrets: ChannelSecrets }> {
  console.log('\n--- Step 4: Messaging Channels ---\n');

  const secrets: ChannelSecrets = {};
  const channels: ChannelConfig = {
    telegram: { enabled: false, allowedUserIds: [] },
    whatsapp: { enabled: false },
    discord: { enabled: false, allowedUserIds: [] },
    slack: { enabled: false, allowedUserIds: [] },
    webchat: { enabled: false },
  };

  // Telegram
  const useTelegram = await askYesNo(rl, 'Enable Telegram?', false);
  if (useTelegram) {
    channels.telegram.enabled = true;
    const token = await ask(rl, 'Enter your Telegram bot token: ');
    if (token) secrets.TELEGRAM_BOT_TOKEN = token;
    const userId = await ask(rl, 'Enter your Telegram user ID (for allowlist): ');
    if (userId) channels.telegram.allowedUserIds.push(userId);
  }

  // WhatsApp
  const useWhatsApp = await askYesNo(rl, 'Enable WhatsApp?', false);
  if (useWhatsApp) {
    channels.whatsapp.enabled = true;
    console.log('WhatsApp will pair via QR code on first start.');
  }

  // Discord
  const useDiscord = await askYesNo(rl, 'Enable Discord?', false);
  if (useDiscord) {
    channels.discord.enabled = true;
    const token = await ask(rl, 'Enter your Discord bot token: ');
    if (token) secrets.DISCORD_BOT_TOKEN = token;
    const userId = await ask(rl, 'Enter your Discord user ID (for allowlist): ');
    if (userId) channels.discord.allowedUserIds.push(userId);
  }

  // Slack
  const useSlack = await askYesNo(rl, 'Enable Slack?', false);
  if (useSlack) {
    channels.slack.enabled = true;
    const botToken = await ask(rl, 'Enter your Slack bot token (xoxb-...): ');
    if (botToken) secrets.SLACK_BOT_TOKEN = botToken;
    const appToken = await ask(rl, 'Enter your Slack app token (xapp-...): ');
    if (appToken) secrets.SLACK_APP_TOKEN = appToken;
    const userId = await ask(rl, 'Enter your Slack user ID (for allowlist): ');
    if (userId) channels.slack.allowedUserIds.push(userId);
  }

  // WebChat (always recommended)
  const useWebChat = await askYesNo(rl, 'Enable WebChat (built-in browser UI)?', true);
  channels.webchat.enabled = useWebChat;

  const enabled = Object.entries(channels).filter(([, v]) => 'enabled' in v && v.enabled).map(([k]) => k);
  console.log(`\nEnabled channels: ${enabled.join(', ') || 'none'}`);

  return { channels, secrets };
}

async function step5_research(
  rl: ReadlineInterface,
  mainProvider: string,
): Promise<{ researchProvider: string; basicModel: string; deepModel: string; perplexityKey?: string }> {
  console.log('\n--- Step 5: Web Search & Research ---\n');
  console.log('ClawLite uses Perplexity Sonar models for web search and deep research.');

  let researchProvider = 'openrouter';
  let perplexityKey: string | undefined;

  if (mainProvider === 'openrouter') {
    const useOpenRouter = await askYesNo(rl, 'Use OpenRouter for Perplexity models? (simplest)', true);
    if (!useOpenRouter) {
      researchProvider = 'perplexity';
      perplexityKey = await ask(rl, 'Enter your Perplexity API key: ');
    }
  } else {
    console.log('You can use Perplexity directly or via OpenRouter.');
    const choice = await askChoice(rl, 'Research provider:', [
      { label: 'OpenRouter (recommended)', value: 'openrouter' },
      { label: 'Direct Perplexity API', value: 'perplexity' },
    ]);
    researchProvider = choice;
    if (choice === 'perplexity') {
      perplexityKey = await ask(rl, 'Enter your Perplexity API key: ');
    } else {
      const hasORKey = await askYesNo(rl, 'Do you have an OpenRouter API key for research?', false);
      if (hasORKey) {
        // Will store separately if main provider is not OpenRouter
        perplexityKey = await ask(rl, 'Enter your OpenRouter API key for research: ');
      }
    }
  }

  const prefix = researchProvider === 'openrouter' ? 'perplexity/' : '';
  const basicModel = await askDefault(rl, 'Basic search model', `${prefix}sonar`);
  const deepModel = await askDefault(rl, 'Deep research model', `${prefix}sonar-deep-research`);

  console.log(`\nResearch configured:`);
  console.log(`  provider: ${researchProvider}`);
  console.log(`  basic:    ${basicModel}`);
  console.log(`  deep:     ${deepModel}`);

  return { researchProvider, basicModel, deepModel, perplexityKey };
}

async function step6_googleWorkspace(
  rl: ReadlineInterface,
): Promise<{ gwsPath?: string }> {
  console.log('\n--- Step 6: Google Workspace (Optional) ---\n');
  console.log('Enables Gmail, Calendar, and Drive integration via gws CLI.');

  const useGws = await askYesNo(rl, 'Do you have Google Workspace credentials?', false);
  if (!useGws) {
    console.log('Skipped. You can set this up later.');
    return {};
  }

  const gwsPath = await ask(rl, 'Credentials path: ');
  if (gwsPath && existsSync(gwsPath)) {
    console.log('Google Workspace connected (Gmail, Calendar, Drive)');
  } else if (gwsPath) {
    console.log(`Warning: File not found at ${gwsPath}. You can update this later in .clawlite/.env`);
  }
  return { gwsPath: gwsPath || undefined };
}

async function step7_budgets(
  rl: ReadlineInterface,
): Promise<{ dailyTokens: number; perJobTokens: number }> {
  console.log('\n--- Step 7: Budgets ---\n');
  console.log('Daily token budget — total tokens all agents can use in 24 hours.');
  console.log('At typical model prices, 200K tokens ~ $0.80/day.\n');

  const dailyInput = await askDefault(rl, 'Daily token budget', '200000');
  const daily = parseNumberInput(dailyInput) || 200000;
  const perJobInput = await askDefault(rl, 'Per-job token budget', '50000');
  const perJob = parseNumberInput(perJobInput) || 50000;

  console.log(`\nDaily: ${daily.toLocaleString()} tokens | Per-job: ${perJob.toLocaleString()} tokens`);
  return { dailyTokens: daily, perJobTokens: perJob };
}

interface UserProfile {
  name: string;
  location: string;
  business: string;
  role: string;
  contacts: string[];
  emailTone: string;
  notes: string;
}

async function step8_profile(rl: ReadlineInterface): Promise<UserProfile> {
  console.log('\n--- Step 8: Your Profile ---\n');
  console.log('Tell your operator about yourself so it can personalize responses,');
  console.log('draft emails in your voice, and know your business context.\n');

  const name = await askDefault(rl, 'Your name', 'User');
  const location = await askDefault(rl, 'Your location', '');
  const business = await askDefault(rl, 'Your business/company', '');
  const role = await askDefault(rl, 'Your role', '');

  const contacts = await askMultiLine(rl, '\nKey contacts (one per line, blank line to finish):');

  const emailTone = await askChoice(rl, '\nEmail tone preference:', [
    { label: 'Formal and professional', value: 'formal and professional' },
    { label: 'Professional but direct (first-name basis)', value: 'professional but direct, first-name basis' },
    { label: 'Casual and friendly', value: 'casual and friendly' },
  ]);

  const notes = await askDefault(rl, '\nAnything else your operator should know about you?', '');

  console.log('\nProfile saved to .clawlite/USER.md');
  console.log('Tip: Tell your operator "remember that..." anytime to update your profile.');
  return { name, location, business, role, contacts, emailTone, notes };
}

async function step9_heartbeat(
  rl: ReadlineInterface,
): Promise<{ enabled: boolean; intervalMinutes: number; conditions: string[] }> {
  console.log('\n--- Step 9: Heartbeat (Optional) ---\n');
  console.log('The heartbeat lets your operator proactively check conditions on a schedule');
  console.log('and alert you or take action — without you asking.\n');

  const enabled = await askYesNo(rl, 'Enable heartbeat?', true);
  if (!enabled) {
    return { enabled: false, intervalMinutes: 30, conditions: [] };
  }

  const intervalInput = await askDefault(rl, 'Check interval in minutes', '30');
  const interval = parseNumberInput(intervalInput) || 30;
  const conditions = await askMultiLine(rl, '\nWhat should your operator check for? (one per line, blank to finish):');

  console.log(`\nHeartbeat enabled (every ${interval} minutes)`);
  console.log(`${conditions.length} condition(s) saved to .clawlite/HEARTBEAT.md`);
  return { enabled, intervalMinutes: interval, conditions };
}

async function step10_http(
  rl: ReadlineInterface,
): Promise<{ enabled: boolean; port: number }> {
  console.log('\n--- Step 10: HTTP Server ---\n');

  const enabled = await askYesNo(rl, 'Enable webhooks + artifact viewer?', true);
  if (!enabled) {
    return { enabled: false, port: 18790 };
  }

  const portInput = await askDefault(rl, 'Port', '18790');
  const port = parseNumberInput(portInput) || 18790;
  console.log(`\nServer at http://127.0.0.1:${port}`);
  console.log('Webhook token generated.');
  return { enabled, port };
}

function step11_tour(operatorName: string): void {
  console.log('\n--- Step 11: Quick Tour ---\n');
  console.log(`Here's what you can tell ${operatorName}:\n`);
  console.log('  Email:     "check my inbox" or /inbox');
  console.log('  Calendar:  "what\'s on today" or /today');
  console.log('  Research:  "research AI agents" or /research <topic>');
  console.log('  Content:   "draft tweets about..."');
  console.log('  Status:    "what\'s your status" or /status');
  console.log('  Agents:    "show my agents" or /agents');
  console.log('  Budget:    "how\'s the budget" or /budget');
  console.log('  Build:     "I need a marketing agent that..."');
  console.log('  Remember:  "remember that my main client is..."');
  console.log('  Heartbeat: "add heartbeat check: alert if..."');
  console.log('  Files:     Drop any file in chat to use it');
  console.log(`\nEverything starts with a conversation. Just tell ${operatorName} what you need.`);
}

// ─── File generators ─────────────────────────────────────────────────

function generateConfigJson(
  operator: { name: string; persona: string },
  llm: { provider: string; tiers: { fast: string; balanced: string; strong: string } },
  research: { provider: string; models: { basic: string; deep: string } },
  channels: ChannelConfig,
  budgets: { dailyTokens: number; perJobTokens: number },
  heartbeat: { enabled: boolean; intervalMinutes: number },
  http: { enabled: boolean; port: number },
): Record<string, unknown> {
  return {
    operator: {
      name: operator.name,
      persona: operator.persona,
    },
    llm: {
      provider: llm.provider,
      tiers: llm.tiers,
    },
    research: {
      provider: research.provider,
      models: research.models,
    },
    channels: {
      telegram: { enabled: channels.telegram.enabled, allowedUserIds: channels.telegram.allowedUserIds },
      whatsapp: { enabled: channels.whatsapp.enabled },
      discord: { enabled: channels.discord.enabled, allowedUserIds: channels.discord.allowedUserIds },
      slack: { enabled: channels.slack.enabled, allowedUserIds: channels.slack.allowedUserIds },
      webchat: { enabled: channels.webchat.enabled },
    },
    tools: {
      workspace: { enabled: true },
      research: { enabled: true },
    },
    budgets: {
      dailyTokens: budgets.dailyTokens,
      perJobTokens: budgets.perJobTokens,
      maxToolCallsPerJob: 200,
    },
    hardLimits: {
      maxNodesPerJob: 20,
      maxTotalLLMCalls: 30,
      maxJobDurationMs: 300000,
      maxRetriesTotalPerJob: 10,
      agenticMaxIterations: 5,
      agenticMaxNodes: 10,
      agenticMaxTokenBudget: 30000,
    },
    heartbeat: {
      enabled: heartbeat.enabled,
      intervalMinutes: heartbeat.intervalMinutes,
      model: 'fast',
    },
    http: {
      enabled: http.enabled,
      port: http.port,
      host: '127.0.0.1',
    },
    session: {
      maxTurnsInMemory: 20,
      turnsInjectedIntoChat: 5,
      compactionThresholdTokens: 8000,
    },
    uploads: {
      maxFileSizeMB: 25,
      allowedTypes: ['document', 'image', 'audio'],
    },
  };
}

function generateEnvFile(
  provider: string,
  apiKey: string,
  channelSecrets: ChannelSecrets,
  perplexityKey?: string,
  gwsPath?: string,
  webhookToken?: string,
): string {
  const lines: string[] = [
    '# .clawlite/.env — auto-managed by ClawLite, editable by user',
    '# WARNING: Never commit this file to version control',
    '',
  ];

  // LLM Provider
  const keyName = PROVIDER_API_KEY_NAMES[provider] ?? `${provider.toUpperCase()}_API_KEY`;
  if (apiKey) {
    lines.push('# LLM Provider');
    lines.push(`${keyName}=${apiKey}`);
    lines.push('');
  }

  // Perplexity / Research
  if (perplexityKey) {
    lines.push('# Research');
    lines.push(`PERPLEXITY_API_KEY=${perplexityKey}`);
    lines.push('');
  }

  // Google Workspace
  if (gwsPath) {
    lines.push('# Google Workspace');
    lines.push(`GWS_CREDENTIALS_PATH=${gwsPath}`);
    lines.push('');
  }

  // Channel secrets
  if (channelSecrets.TELEGRAM_BOT_TOKEN) {
    lines.push('# Telegram');
    lines.push(`TELEGRAM_BOT_TOKEN=${channelSecrets.TELEGRAM_BOT_TOKEN}`);
    lines.push('');
  }
  if (channelSecrets.DISCORD_BOT_TOKEN) {
    lines.push('# Discord');
    lines.push(`DISCORD_BOT_TOKEN=${channelSecrets.DISCORD_BOT_TOKEN}`);
    lines.push('');
  }
  if (channelSecrets.SLACK_BOT_TOKEN) {
    lines.push('# Slack');
    lines.push(`SLACK_BOT_TOKEN=${channelSecrets.SLACK_BOT_TOKEN}`);
    if (channelSecrets.SLACK_APP_TOKEN) {
      lines.push(`SLACK_APP_TOKEN=${channelSecrets.SLACK_APP_TOKEN}`);
    }
    lines.push('');
  }

  // Webhook token
  if (webhookToken) {
    lines.push('# HTTP Webhooks');
    lines.push(`WEBHOOK_TOKEN=${webhookToken}`);
    lines.push('');
  }

  return lines.join('\n');
}

function generateGitignore(): string {
  return `.env
.env.local
*.log
clawlite.db
clawlite.db-wal
clawlite.db-shm
`;
}

function generatePersonaMd(name: string, persona: string): string {
  return `# ${name}

${persona}

## Core behavior
- Direct, efficient, and transparent
- Always explain what you're doing and why
- Ask for approval before any external action

## Communication style
- Professional but not stiff
- Use bullet points for multi-item responses
- Keep responses concise — no filler
`;
}

function generateUserMd(profile: UserProfile): string {
  const lines: string[] = ['# User Profile', ''];
  if (profile.name) lines.push(`- Name: ${profile.name}`);
  if (profile.location) lines.push(`- Location: ${profile.location}`);
  if (profile.business) lines.push(`- Business: ${profile.business}`);
  if (profile.role) lines.push(`- Role: ${profile.role}`);
  if (profile.emailTone) lines.push(`- Email tone: ${profile.emailTone}`);
  if (profile.notes) lines.push(`- ${profile.notes}`);

  if (profile.contacts.length > 0) {
    lines.push('', '## Key Contacts');
    for (const c of profile.contacts) {
      lines.push(`- ${c}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function generateHeartbeatMd(conditions: string[]): string {
  const lines = ['# Heartbeat Checks', ''];
  for (const c of conditions) {
    lines.push(`- ${c}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ─── Main wizard ─────────────────────────────────────────────────────

async function runFullSetup(): Promise<void> {
  const rl = createRl();

  try {
    console.log('');
    console.log('='.repeat(55));
    console.log('  ClawLite Setup Wizard');
    console.log('='.repeat(55));
    console.log('\nThis wizard will set up your AI operator in 11 steps.');
    console.log('Press Enter to accept defaults shown in [brackets].\n');

    // Step 1: Operator identity
    const operator = await step1_operatorIdentity(rl);

    // Step 2: LLM Provider
    const { provider, apiKey } = await step2_llmProvider(rl);

    // Step 3: Model tiers
    const tiers = await step3_modelTiers(rl, provider);

    // Step 4: Channels
    const { channels, secrets: channelSecrets } = await step4_channels(rl);

    // Step 5: Research
    const research = await step5_research(rl, provider);

    // Step 6: Google Workspace
    const gws = await step6_googleWorkspace(rl);

    // Step 7: Budgets
    const budgets = await step7_budgets(rl);

    // Step 8: User profile
    const profile = await step8_profile(rl);

    // Step 9: Heartbeat
    const heartbeat = await step9_heartbeat(rl);

    // Step 10: HTTP server
    const http = await step10_http(rl);

    // Step 11: Quick tour
    step11_tour(operator.name);

    // ── Write all files ──────────────────────────────────────────

    const home = join(process.cwd(), '.clawlite');

    // Create directories
    if (!existsSync(home)) mkdirSync(home, { recursive: true });
    const templatesDir = join(home, 'templates');
    if (!existsSync(templatesDir)) mkdirSync(templatesDir, { recursive: true });
    const workspaceDir = join(home, 'workspace');
    if (!existsSync(workspaceDir)) mkdirSync(workspaceDir, { recursive: true });

    // Generate webhook token
    const webhookToken = randomBytes(32).toString('hex');

    // config.json
    const config = generateConfigJson(
      operator,
      { provider, tiers },
      { provider: research.researchProvider, models: { basic: research.basicModel, deep: research.deepModel } },
      channels,
      budgets,
      heartbeat,
      http,
    );
    writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf-8');

    // .env
    const envContent = generateEnvFile(provider, apiKey, channelSecrets, research.perplexityKey, gws.gwsPath, webhookToken);
    writeFileSync(join(home, '.env'), envContent, 'utf-8');

    // .gitignore
    writeFileSync(join(home, '.gitignore'), generateGitignore(), 'utf-8');

    // PERSONA.md
    writeFileSync(join(home, 'PERSONA.md'), generatePersonaMd(operator.name, operator.persona), 'utf-8');

    // USER.md
    writeFileSync(join(home, 'USER.md'), generateUserMd(profile), 'utf-8');

    // HEARTBEAT.md
    writeFileSync(join(home, 'HEARTBEAT.md'), generateHeartbeatMd(heartbeat.conditions), 'utf-8');

    // ── Final summary ────────────────────────────────────────────

    console.log('\n' + '='.repeat(55));
    console.log('  Setup Complete');
    console.log('='.repeat(55));
    console.log('');
    console.log(`  config.json        (non-sensitive config)`);
    console.log(`  .env               (API keys — never commit this)`);
    console.log(`  .gitignore         (protects .env)`);
    console.log(`  PERSONA.md         (${operator.name}'s personality — editable)`);
    console.log(`  USER.md            (your profile — update via chat)`);
    console.log(`  HEARTBEAT.md       (proactive checks — update via chat)`);
    console.log(`  templates/         (built-in templates ready)`);
    console.log('');
    console.log('  Default sub-agents will be created on first start:');
    console.log('    inbox, calendar, research, publisher');
    console.log('');
    console.log('  Run:  npx tsx src/cli/index.ts start     (foreground)');
    console.log('        npm run dev                        (foreground)');
    console.log('');
    console.log('='.repeat(55));
  } finally {
    rl.close();
  }
}

// ─── Partial re-run helpers ──────────────────────────────────────────

async function rerunChannelSetup(channelName: string): Promise<void> {
  const rl = createRl();
  try {
    const home = join(process.cwd(), '.clawlite');
    const configPath = join(home, 'config.json');
    if (!existsSync(configPath)) {
      console.log('No config found. Run "clawlite setup" first.');
      return;
    }

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const envPath = join(home, '.env');
    let envContent = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';

    console.log(`\n--- Re-configuring ${channelName} ---\n`);

    if (channelName === 'telegram') {
      const enabled = await askYesNo(rl, 'Enable Telegram?', config.channels?.telegram?.enabled ?? false);
      config.channels.telegram = { enabled, allowedUserIds: [] };
      if (enabled) {
        const token = await ask(rl, 'Enter your Telegram bot token: ');
        if (token) {
          envContent = updateEnvKey(envContent, 'TELEGRAM_BOT_TOKEN', token);
        }
        const userId = await ask(rl, 'Enter your Telegram user ID: ');
        if (userId) config.channels.telegram.allowedUserIds.push(userId);
      }
    } else if (channelName === 'webchat') {
      const enabled = await askYesNo(rl, 'Enable WebChat?', config.channels?.webchat?.enabled ?? true);
      config.channels.webchat = { enabled };
    } else if (channelName === 'discord') {
      const enabled = await askYesNo(rl, 'Enable Discord?', config.channels?.discord?.enabled ?? false);
      config.channels.discord = { enabled, allowedUserIds: [] };
      if (enabled) {
        const token = await ask(rl, 'Enter your Discord bot token: ');
        if (token) envContent = updateEnvKey(envContent, 'DISCORD_BOT_TOKEN', token);
        const userId = await ask(rl, 'Enter your Discord user ID: ');
        if (userId) config.channels.discord.allowedUserIds.push(userId);
      }
    } else if (channelName === 'slack') {
      const enabled = await askYesNo(rl, 'Enable Slack?', config.channels?.slack?.enabled ?? false);
      config.channels.slack = { enabled, allowedUserIds: [] };
      if (enabled) {
        const botToken = await ask(rl, 'Enter your Slack bot token: ');
        if (botToken) envContent = updateEnvKey(envContent, 'SLACK_BOT_TOKEN', botToken);
        const appToken = await ask(rl, 'Enter your Slack app token: ');
        if (appToken) envContent = updateEnvKey(envContent, 'SLACK_APP_TOKEN', appToken);
        const userId = await ask(rl, 'Enter your Slack user ID: ');
        if (userId) config.channels.slack.allowedUserIds.push(userId);
      }
    } else {
      console.log(`Unknown channel: ${channelName}`);
      return;
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    writeFileSync(envPath, envContent, 'utf-8');
    console.log(`\n${channelName} configuration updated.`);
  } finally {
    rl.close();
  }
}

async function rerunModelSetup(): Promise<void> {
  const rl = createRl();
  try {
    const home = join(process.cwd(), '.clawlite');
    const configPath = join(home, 'config.json');
    if (!existsSync(configPath)) {
      console.log('No config found. Run "clawlite setup" first.');
      return;
    }

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const provider = config.llm?.provider ?? 'openrouter';
    const tiers = await step3_modelTiers(rl, provider);
    config.llm.tiers = tiers;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    console.log('\nModel tiers updated.');
  } finally {
    rl.close();
  }
}

async function rerunBudgetSetup(): Promise<void> {
  const rl = createRl();
  try {
    const home = join(process.cwd(), '.clawlite');
    const configPath = join(home, 'config.json');
    if (!existsSync(configPath)) {
      console.log('No config found. Run "clawlite setup" first.');
      return;
    }

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const budgets = await step7_budgets(rl);
    config.budgets = { ...config.budgets, ...budgets };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    console.log('\nBudgets updated.');
  } finally {
    rl.close();
  }
}

function updateEnvKey(envContent: string, key: string, value: string): string {
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(envContent)) {
    return envContent.replace(regex, `${key}=${value}`);
  }
  return envContent + `\n${key}=${value}\n`;
}

// ─── Command registration ────────────────────────────────────────────

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Run the onboarding wizard')
    .option('--channel <name>', 'Re-run setup for one channel only')
    .option('--models', 'Re-run model tier selection only')
    .option('--budgets', 'Re-run budget configuration only')
    .action(async (options) => {
      if (options.channel) {
        await rerunChannelSetup(options.channel);
        return;
      }

      if (options.models) {
        await rerunModelSetup();
        return;
      }

      if (options.budgets) {
        await rerunBudgetSetup();
        return;
      }

      await runFullSetup();
    });
}

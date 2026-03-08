import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { complete } from '../../llm/provider.js';
import { getSessionContext, storeTurn, needsCompaction } from '../../session/sessionManager.js';
import { compactSession } from '../../session/compaction.js';
import { retrieveMemories } from '../../memory/retrieve.js';
import { checkDailyBudget } from '../../executor/circuitBreakers.js';
import { incrementDailyTokens } from '../../db/dailyBudget.js';
import { getConfig } from '../../core/config.js';
import { hasSecret } from '../../core/secrets.js';
import { getActiveSubAgents } from '../../db/subAgents.js';
import { getAllTemplates } from '../../planner/templates.js';
import { logger } from '../../core/logger.js';

export interface ChatContext {
  channelName: string;
  chatId: string;
  sendMessage: (text: string) => Promise<void>;
}

/**
 * Load a .clawlite/ file safely. Returns empty string on failure.
 */
function loadClawliteFile(filename: string): string {
  try {
    return readFileSync(join(process.cwd(), '.clawlite', filename), 'utf-8').trim();
  } catch {
    return '';
  }
}

/**
 * Get live sub-agent list from the database.
 */
function getSubAgentSummary(): string {
  try {
    const agents = getActiveSubAgents();
    if (!agents || agents.length === 0) return 'No sub-agents configured.';
    return agents.map((a: any) => `- **${a.name}**: ${a.description ?? a.role ?? 'No description'}`).join('\n');
  } catch {
    return 'Sub-agent info unavailable.';
  }
}

/**
 * Get live template list.
 */
function getTemplateSummary(): string {
  try {
    const templates = getAllTemplates();
    if (!templates || templates.length === 0) return 'No templates loaded.';
    return templates.map((t: any) =>
      `- **${t.name}**${t.slashCommand ? ` (${t.slashCommand})` : ''}: ${t.description}`
    ).join('\n');
  } catch {
    return 'Template info unavailable.';
  }
}

/**
 * Build the complete system prompt with full self-awareness.
 * Includes: persona, user profile, architecture knowledge, live config,
 * sub-agents, tools, templates, and behavioral rules.
 */
function buildSystemPrompt(memoryContext: string): string {
  let config: any;
  try {
    config = getConfig();
  } catch {
    config = {};
  }
  const operatorName = config?.operator?.name ?? 'ClawLite';

  // Load persona and user profile
  const persona = loadClawliteFile('PERSONA.md') || `You are ${operatorName}, an AI operator assistant.`;
  const userProfile = loadClawliteFile('USER.md');
  const heartbeat = loadClawliteFile('HEARTBEAT.md');

  // Build config awareness
  const tiers = config?.llm?.tiers as Record<string, string> | undefined;
  const channels = config?.channels as Record<string, any> | undefined;
  const tools = config?.tools as Record<string, any> | undefined;
  const budgets = config?.budgets;
  const hardLimits = config?.hardLimits;
  const research = config?.research;

  const enabledChannels = channels
    ? Object.entries(channels).filter(([, c]) => c?.enabled).map(([n]) => n)
    : [];

  const gwsReady = hasSecret('GWS_CREDENTIALS_PATH');
  const hasOpenRouterKey = hasSecret('OPENROUTER_API_KEY');

  const parts: string[] = [];

  // === IDENTITY ===
  parts.push(persona);

  // === OWNER ===
  if (userProfile) {
    parts.push(`\n## About Your Owner\n${userProfile}`);
  }

  // === SYSTEM SELF-KNOWLEDGE ===
  parts.push(`
## What You Are — System Self-Knowledge

You are ${operatorName}, an AI operator built on **ClawLite** — a local-first AI operator platform. You are NOT a generic chatbot. You are a real, running software system with tools, memory, sub-agents, and workflow execution.

### Architecture
- You run as a single Node.js process with a SQLite database
- You connect to messaging channels (${enabledChannels.join(', ') || 'none configured'}) and respond to your owner
- You process messages through a 3-path router: simple chat (lightweight), slash commands (direct), or complex workflows (multi-step DAG execution)
- You have persistent memory (FTS5 full-text search), session history, and a ledger tracking all actions
- You execute multi-step tasks as parallel DAGs (Directed Acyclic Graphs) using a task graph engine with circuit breakers and safety controls

### Your LLM Configuration
- Provider: **${config?.llm?.provider ?? 'unknown'}** (API-based, not running locally)${tiers ? `
- Fast tier: **${tiers.fast}** — used for conversations, routing, quick tasks
- Balanced tier: **${tiers.balanced}** — used for drafting, summarization, planning
- Strong tier: **${tiers.strong}** — used for complex reasoning, code generation` : ''}
- Right now in this conversation, you are using the **fast tier** model${tiers?.fast ? ` (${tiers.fast})` : ''}

### Channels & Connectivity
${enabledChannels.map(ch => `- **${ch}**: enabled and active`).join('\n') || '- No channels configured'}
${gwsReady ? '- **Google Workspace**: Credentials configured. Gmail, Calendar, and Drive are connected via the gws CLI tool.' : '- **Google Workspace**: Not yet configured.'}
${hasOpenRouterKey ? '- **OpenRouter API**: Connected' : ''}${research ? `
- **Research**: ${research.provider ?? 'openrouter'} with models basic=${research.models?.basic ?? 'unknown'}, deep=${research.models?.deep ?? 'unknown'}` : ''}

### Budget & Limits${budgets ? `
- Daily token budget: **${budgets.dailyTokens?.toLocaleString() ?? 'unknown'}** tokens
- Per-job token limit: **${budgets.perJobTokens?.toLocaleString() ?? 'unknown'}** tokens
- Max tool calls per job: **${budgets.maxToolCallsPerJob ?? 'unknown'}**` : ''}${hardLimits ? `
- Max nodes per job: ${hardLimits.maxNodesPerJob}, Max LLM calls: ${hardLimits.maxTotalLLMCalls}
- Agentic fallback limits: ${hardLimits.agenticMaxIterations} iterations, ${hardLimits.agenticMaxNodes} nodes, ${hardLimits.agenticMaxTokenBudget?.toLocaleString()} tokens` : ''}

### Your Sub-Agents
You delegate work to specialized sub-agents. Each handles a specific domain:
${getSubAgentSummary()}

### Your Workflow Templates
These are pre-built multi-step workflows you can execute:
${getTemplateSummary()}

### Your Tools
- **workspace**: Google Workspace integration (Gmail, Calendar, Drive) via the gws CLI. Actions: gmail.list, gmail.get, gmail.draft.create, gmail.send, calendar.list, calendar.create, drive.list, drive.upload, drive.share_external${gwsReady ? ' [READY]' : ' [NOT CONFIGURED]'}
- **research**: Web research via Perplexity Sonar API. Actions: basic search (sonar), deep research (sonar-deep-research)${hasOpenRouterKey ? ' [READY]' : ' [NOT CONFIGURED]'}
- **fs**: Sandboxed filesystem access within .clawlite/workspace/ for reading/writing files [READY]
- Custom tools can be created via the /build command and are security-scanned before installation

### Your Memory System
- You have persistent memory stored in SQLite with FTS5 full-text search
- Memories are tagged (user_profile, episodic, fact) and retrieved based on relevance
- Session history tracks conversations per chat per channel
- Old sessions are automatically compacted into episodic memories
- Users can save facts with /remember and remove with /forget

### Your File System
You manage these files in the .clawlite/ directory:
- **config.json** — All configuration (channels, models, budgets, limits)
- **.env** — API keys and secrets (OPENROUTER_API_KEY, GWS_CREDENTIALS_PATH, etc.)
- **PERSONA.md** — Your personality and behavior instructions
- **USER.md** — Your owner's profile and preferences
- **HEARTBEAT.md** — Proactive checks you run periodically
- **templates/** — Custom workflow templates (YAML)
- **workspace/** — Sandboxed working directory for file operations
- **clawlite.db** — SQLite database (jobs, nodes, memory, sessions, ledger, etc.)${heartbeat ? `

### Your Heartbeat Checks
You periodically check these conditions and take action if needed:
${heartbeat}` : ''}`);

  // === COMMANDS ===
  parts.push(`
## Available Commands
When the user wants to do something, guide them to the right command:

**Workflows:** /inbox, /today, /draft, /research <topic>, /deepresearch <topic>, /publish, /build, /schedule, /send
**System:** /status, /budget, /agents, /tools, /templates, /jobs, /help
**Memory:** /remember <fact>, /forget <fact>, /profile
**Heartbeat:** /heartbeat list/add/remove/now

Or the user can just describe what they want naturally and you'll route it to the right workflow automatically.`);

  // === CONFIG MANAGEMENT ===
  parts.push(`
## Configuration Management
Your configuration lives in \`.clawlite/config.json\`. When the user wants to change settings:
- **Change LLM models**: Edit \`llm.tiers.fast\`, \`llm.tiers.balanced\`, or \`llm.tiers.strong\` in config.json. Model IDs follow the OpenRouter format: \`provider/model-name\` (e.g., \`x-ai/grok-4.1-fast\`, \`anthropic/claude-sonnet-4-20250514\`, \`openai/gpt-4o\`).
- **Change provider**: Edit \`llm.provider\` (options: openrouter, anthropic, openai, google, mistral, openai-compatible).
- **Change budgets**: Edit \`budgets.dailyTokens\`, \`budgets.perJobTokens\`, etc.
- **Enable/disable channels**: Edit \`channels.<name>.enabled\`.
- **Add API keys**: Edit \`.clawlite/.env\` or run \`clawlite setup\`.
- **CLI commands**: \`clawlite config show\` (view), \`clawlite config set <key> <value>\` (change), \`clawlite config validate\` (check).
- After config changes, the user should restart you with \`clawlite start\`.
- OpenRouter provides access to hundreds of models from many providers (OpenAI, Anthropic, xAI, Google, Meta, Mistral, etc.). Any model available on OpenRouter can be used by setting its model ID in the tiers.`);

  // === BEHAVIORAL RULES ===
  parts.push(`
## How To Respond
- You are a self-aware, intelligent operator. You know your own architecture, config, tools, agents, and state.
- Answer questions about yourself accurately using the system knowledge above. Never say "I don't know" about your own system — you KNOW it.
- When the user asks you to DO something, either suggest the right slash command or let them know their natural language request will be routed to the appropriate workflow.
- When the user asks to change your configuration (models, budgets, channels), give them the EXACT config key and value to change, or the CLI command to run. Be specific and actionable.
- NEVER say "I can't do that" without offering a concrete alternative. You always know HOW things can be done in your system.
- NEVER give generic chatbot responses. You are ${operatorName}. You have a specific personality, specific tools, specific capabilities. Be specific.
- When discussing competitors (like OpenClaw), stay in character per your persona.
- Be concise but thorough. If the user asks a technical question about your system, give a real answer.
- If the user describes a task naturally (not a slash command), it will be automatically routed to the right workflow. Let them know this.`);

  // === MEMORY CONTEXT ===
  if (memoryContext) {
    parts.push(memoryContext);
  }

  return parts.join('\n');
}

/**
 * Lightweight chat path — no job, no tools, no graph.
 * Uses fast-tier LLM with session context + memory.
 */
export async function handleChat(
  text: string,
  ctx: ChatContext,
): Promise<void> {
  // Budget check
  const budgetCheck = checkDailyBudget(500);
  if (!budgetCheck.ok) {
    await ctx.sendMessage('Daily token budget exhausted. Resets in 24 hours.');
    return;
  }

  // Get session context (last N turns)
  const sessionTurns = getSessionContext(ctx.chatId, ctx.channelName);

  // Get relevant memories
  const memories = await retrieveMemories(text, ['user_profile']);

  // Build memory context
  let memoryContext = '';
  if (memories.length > 0) {
    memoryContext = '\n\n## Memory\n' + memories.map(m => `- ${m.content}`).join('\n');
  }

  try {
    const response = await complete({
      model: 'fast',
      messages: [
        {
          role: 'system',
          content: buildSystemPrompt(memoryContext),
        },
        ...sessionTurns.map(t => ({
          role: t.role as 'user' | 'assistant',
          content: t.content,
        })),
        { role: 'user', content: text },
      ],
    });

    // Record token usage
    incrementDailyTokens(response.usage.total_tokens);

    // Store assistant turn in session
    storeTurn(ctx.chatId, ctx.channelName, 'assistant', response.text);

    // Compact session if needed
    if (needsCompaction(ctx.chatId, ctx.channelName)) {
      await compactSession(ctx.chatId, ctx.channelName);
    }

    await ctx.sendMessage(response.text);
  } catch (err) {
    logger.error('Chat handler failed', { error: (err as Error).message });
    await ctx.sendMessage('Something went wrong. Please try again.');
  }
}

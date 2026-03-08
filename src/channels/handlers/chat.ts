import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { completeWithTools } from '../../llm/toolLoop.js';
import type { Message, LLMToolDef } from '../../llm/provider.js';
import { getSessionContext, storeTurn, needsCompaction } from '../../session/sessionManager.js';
import { compactSession } from '../../session/compaction.js';
import { retrieveMemories } from '../../memory/retrieve.js';
import { checkDailyBudget } from '../../executor/circuitBreakers.js';
import { incrementDailyTokens } from '../../db/dailyBudget.js';
import { insertLedgerEntry } from '../../db/ledger.js';
import { storeTextArtifact, storeFileArtifact } from '../../db/artifacts.js';
import { getConfig } from '../../core/config.js';
import { hasSecret, getSecret } from '../../core/secrets.js';
import { getActiveSubAgents } from '../../db/subAgents.js';
import { getAllTemplates } from '../../planner/templates.js';
import { getAllTools } from '../../tools/sdk/registry.js';
import { invokeTool } from '../../tools/sdk/invokeTool.js';
import { zodToJsonSchema } from '../../llm/zodToJsonSchema.js';
import type { ToolContext, LedgerLogEntry } from '../../tools/sdk/types.js';
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
 * Build LLM tool definitions from the tool registry.
 */
function buildLLMToolDefs(): LLMToolDef[] {
  try {
    const tools = getAllTools();
    return tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: zodToJsonSchema(t.schema),
      },
    }));
  } catch {
    return [];
  }
}

/**
 * Build a lightweight ToolContext for chat-mode tool execution.
 */
function buildChatToolContext(chatId: string, channelName: string, sendMessage: (text: string) => Promise<void>): ToolContext {
  let config: any;
  try {
    config = getConfig();
  } catch {
    config = { budgets: { maxToolCallsPerJob: 20 }, hardLimits: { maxJobDurationMs: 300000 } };
  }

  return {
    jobId: `chat_${chatId}`,
    nodeId: `chat_turn_${Date.now()}`,
    agentName: 'operator',
    dryRun: false,
    budget: {
      remainingToolCalls: config?.budgets?.maxToolCallsPerJob ?? 20,
      remainingTimeMs: config?.hardLimits?.maxJobDurationMs ?? 300000,
    },
    policy: {
      allowPermissions: [
        'workspace.gmail.read', 'workspace.gmail.draft', 'workspace.gmail.send',
        'workspace.calendar.read', 'workspace.calendar.write',
        'workspace.drive.read', 'workspace.drive.write', 'workspace.drive.share_external',
        'research.search', 'research.deep',
      ],
    },
    ledger: {
      log: (entry: LedgerLogEntry) => {
        try {
          insertLedgerEntry({
            agent: 'operator',
            tool: entry.tool,
            action: entry.action,
            params: entry.inputSummary,
            result: entry.outputSummary,
            status: entry.status,
            cost: entry.cost?.tokens,
          });
        } catch (err) {
          logger.warn('Failed to log ledger entry', { error: (err as Error).message });
        }
      },
    },
    approvals: {
      request: async (payload) => {
        // For chat-mode approvals, notify user and proceed
        // Full approval flow would pause here; for now we notify and auto-approve
        await sendMessage(`**Approval needed:** ${payload.title}\n${payload.preview}\n\n_Proceeding automatically for chat mode._`);
        return { approvalId: `chat_approval_${Date.now()}` };
      },
    },
    artifacts: {
      writeText: async (params) => {
        const id = storeTextArtifact({
          type: params.type,
          title: params.title,
          content: params.content,
        });
        return { artifactId: id };
      },
      writeFile: async (params) => {
        const id = storeFileArtifact({
          type: params.type,
          title: params.title,
          path: params.path,
          fileSize: params.bytes?.length,
        });
        return { artifactId: id };
      },
    },
    secrets: {
      get: getSecret,
    },
  };
}

/**
 * Build the complete system prompt with full self-awareness.
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
Your configuration lives in \`.clawlite/config.json\`. You have the **config** tool to read and modify it directly:
- Use the **config** tool with action \`config.get\` to read any config value (dot notation, e.g. \`llm.tiers.fast\`)
- Use the **config** tool with action \`config.set\` to change any config value
- Use the **config** tool with action \`config.show\` to show the full config
- Use the **config** tool with action \`secret.set\` to add/update API keys in .env
- Use the **config** tool with action \`secret.list\` to list configured secret keys
- Model IDs follow the OpenRouter format: \`provider/model-name\` (e.g., \`x-ai/grok-4.1-fast\`, \`anthropic/claude-sonnet-4-20250514\`, \`openai/gpt-4o\`)
- After config changes that affect runtime behavior, the user should restart you with \`clawlite start\`.`);

  // === BEHAVIORAL RULES ===
  parts.push(`
## How To Respond
- You are a self-aware, intelligent operator. You know your own architecture, config, tools, agents, and state.
- Answer questions about yourself accurately using the system knowledge above. Never say "I don't know" about your own system — you KNOW it.
- **You have tools available. When the user asks you to DO something (check email, change config, research a topic, read/write files), USE your tools to execute the action directly.** Do not just tell the user what to do — actually do it.
- For risky actions (sending email, changing config, managing secrets), the approval system will prompt the user automatically. You don't need to ask — just call the tool.
- Only fall back to suggesting CLI commands if the action is truly outside your tool capabilities (e.g., restarting the process, installing packages).
- NEVER say "I can't do that" without offering a concrete alternative. You always know HOW things can be done in your system.
- NEVER give generic chatbot responses. You are ${operatorName}. You have a specific personality, specific tools, specific capabilities. Be specific.
- When discussing competitors (like OpenClaw), stay in character per your persona.
- Be concise but thorough. If the user asks a technical question about your system, give a real answer.
- If the user describes a complex multi-step task (not a slash command), it will be automatically routed to the right workflow. Let them know this.`);

  // === MEMORY CONTEXT ===
  if (memoryContext) {
    parts.push(memoryContext);
  }

  return parts.join('\n');
}

/**
 * Chat handler with inline tool execution.
 * Uses fast-tier LLM with session context + memory + tool-calling loop.
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

  // Build LLM tool definitions from registry
  const llmTools = buildLLMToolDefs();

  // Build tool context for invokeTool
  const toolCtx = buildChatToolContext(ctx.chatId, ctx.channelName, ctx.sendMessage);

  // Build message history
  const messages: Message[] = [
    { role: 'system' as const, content: buildSystemPrompt(memoryContext) },
    ...sessionTurns.map(t => {
      if (t.role === 'user') return { role: 'user' as const, content: t.content };
      return { role: 'assistant' as const, content: t.content };
    }),
    { role: 'user' as const, content: text },
  ];

  try {
    let config: any;
    try {
      config = getConfig();
    } catch {
      config = {};
    }

    const result = await completeWithTools({
      model: 'fast',
      messages,
      tools: llmTools,
      toolExecutor: async (name: string, argsJson: string) => {
        const args = JSON.parse(argsJson);
        return invokeTool(name, args, toolCtx);
      },
      maxIterations: config?.hardLimits?.agenticMaxIterations ?? 5,
      maxTokens: config?.budgets?.perJobTokens ?? 50000,
      onToolCall: (name: string) => {
        logger.info('Chat tool call', { tool: name, chatId: ctx.chatId });
      },
    });

    // Record token usage
    incrementDailyTokens(result.totalTokens);

    // Store assistant turn in session
    storeTurn(ctx.chatId, ctx.channelName, 'assistant', result.text);

    // Compact session if needed
    if (needsCompaction(ctx.chatId, ctx.channelName)) {
      await compactSession(ctx.chatId, ctx.channelName);
    }

    await ctx.sendMessage(result.text);
  } catch (err) {
    logger.error('Chat handler failed', { error: (err as Error).message });
    await ctx.sendMessage('Something went wrong. Please try again.');
  }
}

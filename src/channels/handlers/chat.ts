import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { complete } from '../../llm/provider.js';
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
import { getSecret, isGwsReady } from '../../core/secrets.js';
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

function loadClawliteFile(filename: string): string {
  try {
    return readFileSync(join(process.cwd(), '.clawlite', filename), 'utf-8').trim();
  } catch {
    return '';
  }
}

// ============================================================
// LIGHTWEIGHT CHAT — for simple conversational messages
// No tools, no tool loop, short system prompt. ~200-500 tokens.
// ============================================================

/**
 * Lightweight system prompt — ~200-300 tokens max.
 * For simple chat only. No tool instructions, no architecture dump.
 */
function buildLightSystemPrompt(memorySnippet: string): string {
  let config: any;
  try { config = getConfig(); } catch { config = {}; }
  const name = config?.operator?.name ?? 'ClawLite';

  const persona = loadClawliteFile('PERSONA.md');
  const userProfile = loadClawliteFile('USER.md');

  let prompt = persona || `You are ${name}, an AI operator assistant. Be helpful, concise, and direct.`;

  if (userProfile) {
    const truncated = userProfile.slice(0, 800);
    prompt += `\n\nAbout your user:\n${truncated}`;
  }

  if (memorySnippet) {
    prompt += `\n\n${memorySnippet}`;
  }

  prompt += `\n\nKeep responses concise. If the user asks you to DO something (take an action, check email, research, etc.), tell them you can do it and suggest the right command or just say "let me handle that" — the system will route action requests to the right workflow automatically.`;

  return prompt;
}

/**
 * LIGHTWEIGHT chat handler — for simple conversational messages.
 * No tools, no tool loop, short system prompt. Target: ~200-500 tokens total.
 */
export async function handleChat(
  text: string,
  ctx: ChatContext,
): Promise<void> {
  const budgetCheck = checkDailyBudget(500);
  if (!budgetCheck.ok) {
    await ctx.sendMessage('Daily token budget exhausted. Resets in 24 hours.');
    return;
  }

  const sessionTurns = getSessionContext(ctx.chatId, ctx.channelName);
  const memories = await retrieveMemories(text, ['user_profile']);
  const memorySnippet = memories.length > 0
    ? 'Relevant memory:\n' + memories.map(m => `- ${m.content}`).join('\n')
    : '';

  const messages: Message[] = [
    { role: 'system' as const, content: buildLightSystemPrompt(memorySnippet) },
    ...sessionTurns.map(t => {
      if (t.role === 'user') return { role: 'user' as const, content: t.content };
      return { role: 'assistant' as const, content: t.content };
    }),
    { role: 'user' as const, content: text },
  ];

  try {
    // Direct LLM call — NO tools, NO tool loop
    const result = await complete({
      model: 'fast',
      messages,
    });

    incrementDailyTokens(result.usage.total_tokens);
    storeTurn(ctx.chatId, ctx.channelName, 'assistant', result.text);

    if (needsCompaction(ctx.chatId, ctx.channelName)) {
      await compactSession(ctx.chatId, ctx.channelName);
    }

    await ctx.sendMessage(result.text);
  } catch (err) {
    logger.error('Lightweight chat failed', { error: (err as Error).message });
    await ctx.sendMessage('Something went wrong. Try again.');
  }
}


// ============================================================
// TOOL-CAPABLE CHAT — used by complex handler fallback ONLY
// Full system prompt + tools + ReAct loop. Expensive path.
// ============================================================

function getSubAgentSummary(): string {
  try {
    const agents = getActiveSubAgents();
    if (!agents || agents.length === 0) return 'None configured.';
    return agents.map((a: any) => `- ${a.name}: ${a.description ?? a.role ?? 'No description'}`).join('\n');
  } catch {
    return 'Unavailable.';
  }
}

function buildLLMToolDefs(): LLMToolDef[] {
  try {
    const tools = getAllTools();
    return tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.jsonSchema ?? zodToJsonSchema(t.schema),
      },
    }));
  } catch {
    return [];
  }
}

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
        // Show the approval request to the user
        await sendMessage(
          `**Approval Required**\n` +
          `Action: ${payload.title}\n\n` +
          `${payload.preview}\n\n` +
          `Reply **yes** to approve, **no** to cancel.`
        );
        // Halt the tool loop — user must re-request after approving
        throw new Error('APPROVAL_PENDING:' + payload.title);
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
 * Compact system prompt for tool-capable chat. ~200-400 tokens.
 */
function buildToolSystemPrompt(memoryContext: string): string {
  let config: any;
  try { config = getConfig(); } catch { config = {}; }
  const operatorName = config?.operator?.name ?? 'ClawLite';

  const persona = loadClawliteFile('PERSONA.md') || `You are ${operatorName}, an AI operator.`;
  const userProfile = loadClawliteFile('USER.md');

  const tiers = config?.llm?.tiers as Record<string, string> | undefined;
  const channels = config?.channels as Record<string, any> | undefined;
  const budgets = config?.budgets;

  const enabledChannels = channels
    ? Object.entries(channels).filter(([, c]) => c?.enabled).map(([n]) => n)
    : [];

  const gwsReady = isGwsReady();

  const parts: string[] = [];

  parts.push(persona);

  if (userProfile) {
    const truncated = userProfile.slice(0, 800);
    parts.push(`\nAbout your user:\n${truncated}`);
  }

  // Compact system knowledge
  parts.push(`
## System
You are ${operatorName} running on ClawLite. Provider: ${config?.llm?.provider ?? 'unknown'}.
Models: fast=${tiers?.fast ?? '?'}, balanced=${tiers?.balanced ?? '?'}, strong=${tiers?.strong ?? '?'}.
Channels: ${enabledChannels.join(', ') || 'none'}.
${gwsReady
  ? '- Google Workspace: Connected (Gmail, Calendar, Drive).'
  : '- Google Workspace: NOT connected. When the user asks about email/calendar/drive, use the gws_connect tool to set it up — it will install the CLI if needed and open the browser for authorization. Do NOT tell the user to use the terminal.'}
Budget: ${budgets?.dailyTokens?.toLocaleString() ?? '?'} tokens/day.

Sub-agents: ${getSubAgentSummary()}

Available commands: /inbox, /today, /draft, /research, /status, /budget, /agents, /tools, /remember, /forget, /heartbeat, /help

## Behavior
- Execute actions using your tools when asked. Don't describe steps — do them.
- Be concise. Short answers for simple questions, detailed only when needed.
- If you can't do something, say what's missing and how to fix it.
- Use the config tool for config/model changes. Use workspace for email/calendar. Use research for web lookups.
- You have a shell tool. If you need to copy files, create directories, install packages, or run CLI commands, use it. NEVER tell the user to open a terminal or run commands themselves.
- If Google Workspace isn't connected, use the gws_connect tool. If that needs a client_secret.json file, ask the user where it is, then use the shell tool to copy it to ~/.config/gws/client_secret.json, then call gws_connect again.
- When the gws_connect tool returns a URL, present it to the user as a clickable link. Say something like "Click here to authorize: [URL]". Never tell the user to check their browser — always provide the link directly in chat.`);

  if (memoryContext) {
    parts.push(memoryContext);
  }

  return parts.join('\n');
}

/**
 * TOOL-CAPABLE chat handler — for messages that didn't match a template.
 * Has full tool access, ReAct loop. Called by complex handler fallback only.
 */
export async function handleToolChat(
  text: string,
  ctx: ChatContext,
): Promise<void> {
  const budgetCheck = checkDailyBudget(500);
  if (!budgetCheck.ok) {
    await ctx.sendMessage('Daily token budget exhausted. Resets in 24 hours.');
    return;
  }

  const sessionTurns = getSessionContext(ctx.chatId, ctx.channelName);
  const memories = await retrieveMemories(text, ['user_profile']);

  let memoryContext = '';
  if (memories.length > 0) {
    memoryContext = '\n\n## Memory\n' + memories.map(m => `- ${m.content}`).join('\n');
  }

  const llmTools = buildLLMToolDefs();
  const toolCtx = buildChatToolContext(ctx.chatId, ctx.channelName, ctx.sendMessage);

  const messages: Message[] = [
    { role: 'system' as const, content: buildToolSystemPrompt(memoryContext) },
    ...sessionTurns.map(t => {
      if (t.role === 'user') return { role: 'user' as const, content: t.content };
      return { role: 'assistant' as const, content: t.content };
    }),
    { role: 'user' as const, content: text },
  ];

  try {
    let config: any;
    try { config = getConfig(); } catch { config = {}; }

    const result = await completeWithTools({
      model: 'fast',
      messages,
      tools: llmTools,
      toolExecutor: async (name: string, argsJson: string) => {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(argsJson);
        } catch {
          logger.warn('Tool args JSON parse failed, using empty object', { tool: name, raw: argsJson });
          args = {};
        }

        logger.debug('LLM tool args', { tool: name, args });

        return invokeTool(name, args, toolCtx);
      },
      maxIterations: 3,
      maxTokens: config?.budgets?.perJobTokens ?? 50000,
      onToolCall: (name: string) => {
        logger.info('Chat tool call', { tool: name, chatId: ctx.chatId });
      },
    });

    incrementDailyTokens(result.totalTokens);
    storeTurn(ctx.chatId, ctx.channelName, 'assistant', result.text);

    if (needsCompaction(ctx.chatId, ctx.channelName)) {
      await compactSession(ctx.chatId, ctx.channelName);
    }

    await ctx.sendMessage(result.text);
  } catch (err) {
    logger.error('Tool chat failed', { error: (err as Error).message });
    await ctx.sendMessage('Something went wrong. Please try again.');
  }
}

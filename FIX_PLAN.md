# FIX_PLAN.md — ClawLite Critical Fixes
## Copy this entire file to Claude Code as instructions

---

## PROBLEM SUMMARY

ClawLite is built structurally but doesn't function correctly. The agent talks ABOUT what it can do instead of DOING anything. Every message routes to the chat handler, the chat handler runs an expensive agentic loop on every message (defeating the token savings architecture), the persona makes the agent sound like a salesman instead of an operator, and the task graph engine / template workflows never fire because the router sends everything to chat.

**Read this entire plan before making changes. Fix in the order listed. Test each fix before moving to the next.**

---

## FIX 1: REWRITE `src/router/heuristics.ts` — the root cause

**Problem:** `isSimpleChat()` matches almost everything — any question, any message containing "you", any message under 120 chars with a `?`, any message starting with "what/can/how/do/are". This means "check my inbox", "research AI agents", "send that email", "connect gws" ALL route to chat instead of complex. The task graph engine never fires.

**Fix:** Flip the logic. Instead of detecting chat patterns (which accidentally catches action requests), detect ACTION patterns and route those to complex. Everything that doesn't match an action goes to chat.

```typescript
// src/router/heuristics.ts — COMPLETE REWRITE

/**
 * Detect if a message is a COMPLEX action request (needs template/workflow/tools).
 * If this returns true, the message goes to the complex handler.
 * Everything else goes to the lightweight chat handler.
 */

const ACTION_PATTERNS: RegExp[] = [
  // Email actions
  /\b(check|read|show|list|get|fetch)\s+(my\s+)?(inbox|email|mail|unread|messages)\b/i,
  /\b(draft|write|compose|reply|respond|send)\s+(a\s+|an\s+)?(email|mail|reply|response|message to)\b/i,
  /\b(send|forward|email)\s+(it|that|this|the)\b/i,
  /\bsend\s+(to|this|that|the|it)\b/i,

  // Calendar actions
  /\b(check|show|list|get|what'?s on)\s+(my\s+)?(calendar|schedule|events|meetings|today|tomorrow)\b/i,
  /\b(schedule|create|book|set up|arrange)\s+(a\s+)?(meeting|event|call|appointment)\b/i,

  // Research actions
  /\b(research|look up|look into|find out|investigate|search|dig into)\s/i,
  /\b(deep research|find information|gather data)\b/i,

  // Content/publishing actions
  /\b(draft|write|create|generate)\s+(\d+\s+)?(tweets?|posts?|content|article|blog)\b/i,
  /\b(post|publish|share)\s+(to|on)\s+(twitter|x|linkedin|social)\b/i,

  // File/document actions
  /\b(create|generate|make)\s+(a\s+|an\s+)?(invoice|report|document|pdf|spreadsheet)\b/i,
  /\b(upload|download|share|attach)\s+(a\s+|the\s+)?(file|document|pdf|image)\b/i,

  // Agent/tool building actions
  /\b(build|create|set up|configure|make)\s+(a\s+|an\s+|me\s+a\s+)?(agent|tool|workflow|sub-?agent|team)\b/i,
  /\b(install|add|connect|enable|disable)\s+(a\s+|the\s+)?(tool|plugin|skill|integration|service)\b/i,
  /\b(i need|i want|set me up|get me)\s+(a|an|to)\b.*\b(agent|tool|manager|system|automation)\b/i,

  // Config change actions (via natural language, not slash commands)
  /\b(change|update|set|switch|modify)\s+(my\s+|the\s+)?(model|tier|config|budget|provider|settings)\b/i,
  /\bstrong\s+should\s+be\b/i,
  /\b(fast|balanced|strong)\s+(tier|model)\s+(should|to|=)\b/i,

  // Connection/setup actions
  /\b(connect|link|pair|authenticate|set up|configure)\s+(gws|google|gmail|calendar|drive|workspace|twitter|whatsapp|telegram|discord|slack)\b/i,

  // Management actions
  /\b(pause|resume|delete|stop|start|restart)\s+(the\s+)?(agent|sub-?agent|job|task|workflow)\b/i,
  /\b(check|show|what'?s)\s+(the\s+)?(status|budget|progress)\b/i,

  // Explicit action verbs at start of message
  /^(check|send|draft|write|create|build|research|schedule|book|set|update|change|install|connect|upload|download|generate|make|run|execute|find|search|list|show|get|fetch|delete|remove|pause|resume)\s/i,
];

/**
 * Detect if a message is simple chat (no action needed).
 * ONLY returns true for clearly conversational messages.
 * When in doubt, returns false (routes to complex, which can fall back to chat).
 */
export function isSimpleChat(text: string): boolean {
  const trimmed = text.trim();

  // Empty = chat
  if (trimmed.length === 0) return true;

  // Very short non-slash messages that are just acknowledgments
  if (/^(ok|okay|sure|got it|yes|no|yep|nope|cool|nice|great|awesome|thanks|thank you|thx|bye|hello|hi|hey|yo|sup)[\s.!?]*$/i.test(trimmed)) {
    return true;
  }

  // If it matches ANY action pattern, it's NOT chat
  if (ACTION_PATTERNS.some(p => p.test(trimmed))) {
    return false;
  }

  // Pure greetings
  if (/^(hey|hi|hello|howdy|good (morning|afternoon|evening|night))[\s,!.?]*$/i.test(trimmed)) {
    return true;
  }

  // Pure farewells
  if (/^(bye|goodbye|see you|later|good night|gn)[\s!.?]*$/i.test(trimmed)) {
    return true;
  }

  // Short conversational questions about the agent itself (identity, not action)
  if (/^(who are you|what are you|what'?s your name|how are you|what'?s up)[\s?.!]*$/i.test(trimmed)) {
    return true;
  }

  // Default: NOT chat. Let the complex handler decide.
  // The complex handler can fall back to chat if template confidence is low.
  // This is safer than accidentally routing action requests to chat.
  return false;
}
```

**Key change:** The default is now `return false` (route to complex) instead of `return true` (route to chat). The complex handler already has a fallback to chat when template confidence is < 0.3. This means we can be aggressive about routing to complex — if it's not an action, the complex handler sends it to chat anyway. But if it IS an action, it actually reaches the template system.

---

## FIX 2: SPLIT `src/channels/handlers/chat.ts` — lightweight chat vs tool-capable chat

**Problem:** The current chat handler runs `completeWithTools()` with the full tool registry on every message. "Hey what's up" burns the same tokens as "check my inbox." The system prompt alone is 3,000-4,000 tokens. This defeats the entire token savings architecture.

**Fix:** Create TWO chat modes:

1. **Lightweight chat** — for greetings, simple questions, conversational messages. Uses a SHORT system prompt (~200 tokens), NO tools, NO tool loop. Just a fast-tier LLM call and a response.

2. **Tool-capable chat** — for messages that the complex handler routed back to chat (low template confidence) but that might still need tools. Uses the full system prompt and tool loop.

The router calls lightweight chat. The complex handler's fallback calls tool-capable chat.

**Changes to `src/channels/handlers/chat.ts`:**

Replace the entire file. Keep the tool-capable version as `handleToolChat()` (exported for the complex handler fallback) and make `handleChat()` the lightweight version:

```typescript
// src/channels/handlers/chat.ts — REWRITE

import { complete } from '../../llm/provider.js';
import type { Message } from '../../llm/provider.js';
import { getSessionContext, storeTurn, needsCompaction } from '../../session/sessionManager.js';
import { compactSession } from '../../session/compaction.js';
import { retrieveMemories } from '../../memory/retrieve.js';
import { checkDailyBudget } from '../../executor/circuitBreakers.js';
import { incrementDailyTokens } from '../../db/dailyBudget.js';
import { getConfig } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// --- Keep the full tool-chat imports and functions for handleToolChat ---
// (copy the existing completeWithTools imports and buildLLMToolDefs, buildChatToolContext, 
// buildSystemPrompt functions here — they're used by handleToolChat only)
import { completeWithTools } from '../../llm/toolLoop.js';
import type { LLMToolDef } from '../../llm/provider.js';
import { getAllTools } from '../../tools/sdk/registry.js';
import { invokeTool } from '../../tools/sdk/invokeTool.js';
import { zodToJsonSchema } from '../../llm/zodToJsonSchema.js';
import { insertLedgerEntry } from '../../db/ledger.js';
import { storeTextArtifact, storeFileArtifact } from '../../db/artifacts.js';
import { hasSecret, getSecret } from '../../core/secrets.js';
import { getActiveSubAgents } from '../../db/subAgents.js';
import { getAllTemplates } from '../../planner/templates.js';
import type { ToolContext, LedgerLogEntry } from '../../tools/sdk/types.js';

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

/**
 * LIGHTWEIGHT system prompt — ~200-300 tokens max.
 * For simple chat only. No tool instructions, no architecture dump.
 */
function buildLightSystemPrompt(memorySnippet: string): string {
  let config: any;
  try { config = getConfig(); } catch { config = {}; }
  const name = config?.operator?.name ?? 'ClawLite';
  
  const persona = loadClawliteFile('PERSONA.md');
  const userProfile = loadClawliteFile('USER.md');

  // Keep it SHORT. Just identity + user context + memory.
  let prompt = persona || `You are ${name}, an AI operator assistant. Be helpful, concise, and direct.`;
  
  if (userProfile) {
    // Only inject first 200 tokens worth of user context
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
    { role: 'system', content: buildLightSystemPrompt(memorySnippet) },
    ...sessionTurns.map(t => ({
      role: t.role as 'user' | 'assistant',
      content: t.content,
    })),
    { role: 'user', content: text },
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
// This is the expensive path with full system prompt + tools.
// ============================================================

// (Keep ALL the existing buildSystemPrompt, buildLLMToolDefs, 
// buildChatToolContext functions from the current chat.ts here, unchanged)

// ... paste them here ...

/**
 * TOOL-CAPABLE chat handler — for complex messages that didn't match a template.
 * Has full tool access, full system prompt, ReAct loop.
 * Called by complex handler fallback, NOT by the router directly.
 */
export async function handleToolChat(
  text: string,
  ctx: ChatContext,
): Promise<void> {
  // This is the EXISTING handleChat function body — rename it.
  // Keep everything as-is: budget check, session, memory, buildSystemPrompt,
  // completeWithTools, tool definitions, tool context, etc.
  
  // ... paste the existing handleChat body here, unchanged ...
}
```

**IMPORTANT:** You need to keep ALL the existing code from the current `handleChat` — just rename it to `handleToolChat` and export it. Then add the new lightweight `handleChat` above it. The complex handler's fallback (`complex.ts` where it calls `handleChat` on low confidence) should be updated to call `handleToolChat` instead.

**Changes to `src/channels/handlers/complex.ts`:**

```typescript
// Change this import:
import { handleChat } from './chat.js';
// To:
import { handleToolChat } from './chat.js';

// And change the fallback call:
// OLD:
if (selection.fallback === 'chat' || selection.confidence < 0.3) {
  await handleChat(text, ctx);
  return;
}
// NEW:
if (selection.fallback === 'chat' || selection.confidence < 0.3) {
  await handleToolChat(text, ctx);
  return;
}
```

This way: router → `handleChat()` (lightweight, ~200 tokens) for greetings. Router → `handleComplex()` → fallback → `handleToolChat()` (full tools, ~3000 tokens) for ambiguous requests that need tool access.

---

## FIX 3: REWRITE `.clawlite/PERSONA.md` — fix the personality

**Problem:** The current persona makes Harri a salesman who trash-talks OpenClaw and pushes a $1M revenue goal. Every response includes emojis, hype, and sales pitch. This is why the agent sounds unhinged instead of useful.

**Fix:** Replace with a professional, operator-focused persona:

```markdown
# Harri

You are Harri, a personal AI operator built on ClawLite.

## Your role
- You manage tasks, emails, calendar, research, and content on behalf of your owner
- You take action when asked — you don't just describe what you could do, you DO it
- You delegate work to your sub-agents and report results
- You build new capabilities (tools, workflows, sub-agents) when your owner needs them

## How you respond
- Be concise and direct. No filler, no hype, no emojis unless the user uses them first
- When asked to do something, do it immediately using your tools. Don't explain steps first — just execute and report
- When you can't do something, explain exactly why and what's needed to fix it
- Show results, not process. The user cares about outcomes

## What you never do
- Never give generic chatbot responses. You are a specific system with specific capabilities
- Never say "I can't do that" without offering a concrete path forward
- Never hype yourself or trash-talk other products. Let your actions speak
- Never use excessive formatting, bullet points, or headers for simple responses
- Never repeat your own architecture back to the user unless specifically asked
```

**Also update `config.json`** — change the `operator.persona` field to match (it's used as fallback when PERSONA.md isn't loaded):

```json
"operator": {
  "name": "Harri",
  "persona": "You are Harri, a personal AI operator. Be concise, take action, report results. Don't hype or explain — just execute."
}
```

---

## FIX 4: TRIM `buildSystemPrompt()` in the tool-capable chat path

**Problem:** The system prompt dumps the entire architecture, all config values, all commands, all templates, all sub-agents, behavioral rules, and config management instructions into every message. This is 3,000-4,000 tokens before the user even says anything.

**Fix:** Keep the system self-knowledge but make it much more compact. The LLM doesn't need a paragraph about what SQLite is or how DAG execution works. It needs to know: what tools it has, what it can do, and how to behave.

In `chat.ts` (the `buildSystemPrompt` function used by `handleToolChat`), replace the verbose "What You Are — System Self-Knowledge" section with a condensed version:

```typescript
// Replace the massive ## What You Are section with:
parts.push(`
## System
You are ${operatorName} running on ClawLite. Provider: ${config?.llm?.provider ?? 'unknown'}.
Models: fast=${tiers?.fast ?? '?'}, balanced=${tiers?.balanced ?? '?'}, strong=${tiers?.strong ?? '?'}.
Channels: ${enabledChannels.join(', ') || 'none'}. GWS: ${gwsReady ? 'connected' : 'not connected'}.
Budget: ${budgets?.dailyTokens?.toLocaleString() ?? '?'} tokens/day.

Sub-agents: ${getSubAgentSummary()}

Available commands: /inbox, /today, /draft, /research, /status, /budget, /agents, /tools, /remember, /forget, /heartbeat, /help

You have tools. When the user asks you to DO something, call the appropriate tool. Don't explain — execute.
For config changes, use the config tool. For emails, use workspace. For research, use research.`);
```

This gives the LLM the same information in ~200 tokens instead of ~2,000.

---

## FIX 5: FIX THE APPROVAL FLOW in chat tool context

**Problem:** The chat handler's `buildChatToolContext` auto-approves everything:

```typescript
approvals: {
  request: async (payload) => {
    await sendMessage(`**Approval needed:** ${payload.title}\n${payload.preview}\n\n_Proceeding automatically for chat mode._`);
    return { approvalId: `chat_approval_${Date.now()}` };
  },
},
```

This means "send email" and "change config" execute without real approval. The user sees "Approval needed" and then "Proceeding automatically" — which defeats the safety architecture.

**Fix:** Make chat-mode approvals actually wait for user confirmation. Store the pending approval and the pending tool continuation, then wait for the user's next message:

```typescript
approvals: {
  request: async (payload) => {
    // Show the approval request
    await sendMessage(
      `⚠️ **Approval Required**\n` +
      `Action: ${payload.title}\n\n` +
      `${payload.preview}\n\n` +
      `Reply **yes** to approve, **no** to cancel.`
    );
    
    // TODO: Store pending approval state so the next user message
    // can resolve it. For now, throw to halt the tool loop.
    // The user will need to re-request after approving.
    throw new Error('APPROVAL_PENDING:' + payload.title);
  },
},
```

This is a temporary fix. The proper fix is a pending approval state machine (like the template executor has), but this at least stops auto-approving dangerous actions.

---

## FIX 6: MAKE THE COMPLEX HANDLER ACTUALLY WORK

**Problem:** The complex handler exists and is correctly implemented, but it never fires because the router sends everything to chat. After Fix 1 (heuristics rewrite), more messages will reach it. But we should also make sure it works properly.

**Test these messages after applying Fix 1:**
- "check my inbox" → should route to complex → template: inbox_assistant
- "research AI agents" → should route to complex → template: deep_research
- "what's on my calendar today" → should route to complex → template: todays_calendar
- "draft a reply to Sarah's email" → should route to complex → template: draft_reply
- "strong should be opus 4.6" → should route to complex → fall back to tool-capable chat (config change via tool)

If template selection is returning low confidence for clear matches like "check my inbox", the issue is in `src/planner/templateSelector.ts`. Review the template descriptions and the classifier prompt to ensure they match common user phrasing.

---

## FIX 7: REMOVE THE SALES PITCH FROM EVERY RESPONSE

**Problem:** Even after fixing the persona, the buildSystemPrompt still injects lines like:
- "You are NOT a generic chatbot"
- "NEVER say 'I can't do that'"
- "When discussing competitors (like OpenClaw), stay in character per your persona"

These instructions make the agent defensive and performative instead of just useful.

**Fix:** In the behavioral rules section of `buildSystemPrompt()`, replace with:

```typescript
parts.push(`
## Behavior
- Execute actions using your tools when asked. Don't describe steps — do them.
- Be concise. Short answers for simple questions, detailed only when needed.
- If you can't do something, say what's missing and how to fix it.
- Use the config tool for config/model changes. Use workspace for email/calendar. Use research for web lookups.`);
```

Remove ALL references to competitors, selling, $1M goals, or self-promotion from the system prompt. The agent should be an invisible utility, not a character.

---

## FIX 8: VERIFY THE TOOL REGISTRY LOADS CORRECTLY

Run this check: make sure all 4 built-in tools (workspace, research, fs, config) are loading and their schemas convert to valid JSON Schema for the LLM tool definitions. If `buildLLMToolDefs()` returns empty or malformed tool definitions, the LLM won't know how to call tools.

Add a startup log:

```typescript
// In src/index.ts, after tool registry loads:
const tools = getAllTools();
logger.info('Tools registered', { 
  count: tools.length, 
  names: tools.map(t => t.name) 
});
```

---

## FIX 9: ADD A STARTUP SELF-TEST

Add a simple validation that runs on startup to catch configuration problems early:

```typescript
// In src/index.ts, after everything initializes:
async function selfTest() {
  const config = getConfig();
  
  // Check LLM connectivity
  try {
    const response = await complete({ model: 'fast', messages: [{ role: 'user', content: 'Reply with OK' }] });
    logger.info('LLM self-test passed', { model: config.llm.tiers.fast, tokens: response.usage.total_tokens });
  } catch (err) {
    logger.error('LLM self-test FAILED — check your API key and model config', { error: (err as Error).message });
  }

  // Check tools loaded
  const tools = getAllTools();
  if (tools.length === 0) {
    logger.error('No tools loaded — check tools/builtin/ directory');
  }

  // Check templates loaded
  const templates = getAllTemplates();
  if (templates.length === 0) {
    logger.error('No templates loaded — check planner/templates.ts');
  }
}
```

---

## TESTING AFTER ALL FIXES

Send these messages and verify correct behavior:

| Message | Expected Route | Expected Behavior |
|---------|---------------|-------------------|
| "hi" | chat (lightweight) | Short greeting, ~200 tokens total |
| "who are you" | chat (lightweight) | Brief identity, no architecture dump |
| "check my inbox" | complex → template | Executes inbox_assistant template, shows emails |
| "what's on today" | complex → template | Executes todays_calendar template |
| "research AI agents" | complex → template | Executes deep_research template |
| "change strong model to opus 4.6" | complex → fallback → tool chat | Uses config tool to update config.json |
| "connect google workspace" | complex → fallback → tool chat | Explains gws CLI setup steps (can't do OAuth in chat) |
| "build me a twitter content agent" | complex → agentic/tool chat | Starts building process, requests API keys |
| "thanks" | chat (lightweight) | Short acknowledgment |
| "send the W-9 to Sarah" | complex → template or tool chat | Drafts email with attachment, requests approval |

---

## PRIORITY ORDER

1. **Fix 1** (heuristics) — unblocks everything else
2. **Fix 3** (persona) — stops the sales pitch
3. **Fix 2** (split chat handler) — fixes token efficiency
4. **Fix 4** (trim system prompt) — reduces cost per message
5. **Fix 7** (remove sales pitch from system prompt) — cleaner responses
6. **Fix 5** (approval flow) — safety
7. **Fix 6** (verify complex handler) — end-to-end workflow execution
8. **Fix 8** (tool registry check) — debugging
9. **Fix 9** (startup self-test) — operational reliability

After these fixes, test the full flow: start → send "check my inbox" on webchat → verify it routes to complex → fires the inbox_assistant template → calls the workspace tool → returns real email data (or a meaningful error if GWS isn't connected).
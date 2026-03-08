# CLAWSPEC.md
## Project: ClawLite
### Hybrid Event-Driven Task Graph AI Operator

---

## 1. SYSTEM OVERVIEW

ClawLite is a local-first **AI operator platform** that grows with the user. It starts as a simple assistant and evolves into a team of specialized sub-agents — built through conversation, not code.

On day one, ClawLite might just manage email and calendar. By week two, the user asks it to handle their Twitter presence, so the operator creates a content sub-agent with the right tools and workflows. By month two, the user wants a marketing team — ad analysis, creative generation, landing page optimization — so the operator builds three more sub-agents, each with their own tools, personas, and schedules. The user's capabilities grow with their needs, not limited by what was pre-built.

**Core architecture:**
- A single **Operator Agent** that understands everything, delegates work, and builds new capabilities on demand
- **Dynamic sub-agents** created through conversation — each with their own persona, tools, templates, and budget
- A **task graph engine** that executes workflows as parallel DAGs with safety controls
- A **tool SDK** that lets the operator generate, install, and manage tools for any API or service
- A **template system** where workflows are defined as reusable YAML files — authored by the user, the operator, or installed from external sources

ClawLite must:
- Run entirely on local machine or VPS
- Use SQLite for all storage
- Support parallel agent execution
- Operate tools safely
- Provide audit logging
- Support dynamic tool extensions — both installed and agent-generated
- Support multiple messaging channels (Telegram, WhatsApp, Discord, Slack, WebChat)
- Provide proactive monitoring via heartbeat
- Maintain conversational continuity via session history
- Expose a lightweight HTTP server for webhooks and artifact viewing
- **Allow the operator to create new sub-agents, tools, templates, and workflows through conversation**
- **Give users a general-purpose platform, not a fixed-capability assistant**

ClawLite is inspired by OpenClaw but fixes its critical problems:
- **No infinite loops** — event-driven, graph-based execution only (with a bounded agentic fallback for edge cases)
- **Token efficiency** — model tiering per node, cheap routing, lightweight chat path
- **Deterministic execution** — template graphs for most work, bounded agentic mode as safety-netted fallback
- **Hard circuit breakers** — job-level kill switches prevent runaway spending
- **Parallel sub-agent model** — real concurrency, not sequential chain-of-thought
- **Approval gates** — dangerous actions always require human confirmation
- **Strict tool permissions** — agents only access what they need
- **Persistent structured memory** — FTS5-powered retrieval, not naive string matching
- **Multi-channel** — any supported messaging platform, user's choice, same core runtime
- **Proactive heartbeat** — scheduled condition checks that trigger work through the normal template system
- **Self-building** — the operator can create new tools, templates, sub-agents, and workflows to meet any user need

---

## 2. RUNTIME MODEL

ClawLite runs as one local server process with two listeners:

1. **Channel polling/connections** — messaging platform adapters
2. **HTTP server (Fastify)** — webhooks, artifact viewer, status dashboard

**Main loop responsibilities:**
- Channel message polling/receiving
- Event dispatch
- Message routing (chat vs command vs complex)
- Job creation
- Task graph execution
- Worker scheduling
- Ledger logging
- Memory management
- Heartbeat scheduling
- Session management
- Webhook handling

ClawLite must run on:
- macOS
- Linux
- Windows
- VPS

### Local-first, not external-service-free

ClawLite is **local-first in hosting and storage** — one process, one SQLite database, no self-hosted infrastructure beyond the runtime itself. However, ClawLite **depends on external services for operation**:

| Dependency | Role | Required? |
|-----------|------|-----------|
| LLM provider (Anthropic / OpenRouter) | All agent reasoning and classification | Yes |
| At least one messaging channel | User interface | Yes |
| Google Workspace (via `gws` CLI) | Gmail, Calendar, Drive | Yes for workspace features |
| Perplexity API | Research tool | Yes for research features |

**Channel dependencies (user picks one or more):**

| Channel | Library / Protocol | Required? |
|---------|-------------------|-----------|
| Telegram | `node-telegram-bot-api` (polling) | No — pick at least one |
| WhatsApp | `@whiskeysockets/baileys` (QR pairing) | No — pick at least one |
| Discord | `discord.js` (bot token) | No — pick at least one |
| Slack | `@slack/bolt` (bot token + app) | No — pick at least one |
| WebChat | Built-in (Fastify + WebSocket) | No — pick at least one |

If any of these services are unreachable, the features that depend on them will fail gracefully (with ledger logging), but the core runtime itself has no external infrastructure requirements — no Redis, no Postgres, no message queue, no container orchestrator.

---

## 3. MESSAGE ROUTER (CRITICAL FOR TOKEN SAVINGS)

Every incoming message hits the router before anything else. This is the single biggest architectural difference from OpenClaw — not every message creates a job.

```typescript
type MessageIntent = "chat" | "command" | "complex";

async function routeMessage(text: string): Promise<MessageIntent> {
  // 1. Slash commands are free — no LLM call
  if (text.startsWith("/")) return "command";

  // 2. Simple chat detection — keyword/heuristic first, cheap LLM fallback
  if (isSimpleChat(text)) return "chat";

  // 3. Everything else gets a task graph
  return "complex";
}
```

**"chat" path:** Direct LLM response using the `fast` tier model. No job, no graph, no tools. Costs ~200 tokens. Handles greetings, thanks, questions about past work, simple factual queries, and conversational messages. **Includes recent session history** (last 3-5 turns) for conversational continuity.

**"command" path:** Slash command maps to a predefined template graph. No planning LLM call needed. The template is selected by command name, variables are filled from the command arguments.

**"complex" path:** Freeform message that requires multi-step work. This classifies into the best-matching template graph using a `fast` tier LLM call. If confidence ≥ 0.7, the template executes. If confidence < 0.7 but > 0.3, the **bounded agentic fallback** (Section 3a) handles it. If confidence < 0.3, clarification is requested.

**Why this matters:** OpenClaw treats every message as a mission. "Hey what's up" burns the same token budget as "research AI agents and draft 4 tweets." The router eliminates 50%+ of unnecessary LLM calls.

---

## 3a. BOUNDED AGENTIC FALLBACK (NEW)

When the template classifier can't confidently match a request (confidence 0.3–0.7) but it's clearly not simple chat, ClawLite falls back to a **bounded agentic mode** — a constrained ReAct loop that preserves all safety guarantees.

### How it works

1. A job is created with type `agentic` and all normal budget/circuit-breaker limits apply
2. The `balanced` tier LLM receives the user request, available tools, and a strict instruction to **declare its plan as a JSON array of steps before executing**
3. ClawLite validates the plan as a valid DAG (acyclic, known tool types, reasonable step count)
4. The plan is converted into a TaskGraph and executed through the normal executor
5. If the LLM's plan is invalid or exceeds limits, the job fails gracefully

### Hard limits on agentic mode

```typescript
const AGENTIC_LIMITS = {
  maxIterations: 5,        // max ReAct cycles if plan needs revision
  maxNodes: 10,            // max nodes in the generated graph
  maxTokenBudget: 30000,   // tighter than template jobs
  requirePlanApproval: false, // true in v2 for extra safety
};
```

### Why this exists

OpenClaw's fully open-ended agentic loop is powerful but dangerous. Template-only execution is safe but rigid. The bounded fallback gives 80% of OpenClaw's flexibility with 100% of ClawLite's safety: every generated plan still runs through the executor with circuit breakers, approval gates, budget tracking, and ledger logging. No plan executes without validation.

### Confidence-based routing (updated)

| Confidence | Behavior |
|-----------|----------|
| ≥ 0.9 | Execute template immediately |
| 0.7 – 0.9 | Execute template, include name in confirmation so user can correct |
| 0.3 – 0.7 | **Bounded agentic fallback** — LLM generates a plan, validated and executed as DAG |
| < 0.3 | Ask user to clarify |
| 0.0 / "none" | Fall through to chat path |

---

## 4. LOCAL FILESYSTEM STRUCTURE

ClawLite stores all runtime data locally.

```
.clawlite/
├── clawlite.db
├── .env                    ← NEW: API keys, tokens, credentials (NEVER committed to git)
├── .gitignore              ← auto-generated, includes .env
├── logs/
├── memory/
├── artifacts/
│   └── uploads/            ← NEW: user-uploaded files (PDFs, images, docs)
├── sessions/
├── templates/              ← user-defined and agent-generated template YAML files
│   ├── inbox_assistant.yaml
│   ├── draft_reply.yaml
│   └── ... (generated templates go here too)
├── tools.lock.json         ← version pinning for installed tools
├── PERSONA.md              ← rich operator identity (optional, overrides config persona)
├── USER.md                 ← user preferences and context (optional)
├── HEARTBEAT.md            ← proactive check conditions
└── config.json             ← non-sensitive config only (safe to commit)
```

| Path | Description |
|------|-------------|
| `clawlite.db` | SQLite database (with FTS5 enabled) |
| `logs/` | Runtime logs (structured JSON) |
| `memory/` | Serialized knowledge artifacts |
| `artifacts/` | Outputs generated by agents |
| `sessions/` | Browser or auth sessions |
| `PERSONA.md` | Rich operator persona (loaded into every LLM call, max 1000 tokens) |
| `USER.md` | User preferences, contacts, project context (loaded selectively, max 500 tokens) |
| `HEARTBEAT.md` | Conditions the heartbeat checks on each interval |
| `config.json` | User settings |

### PERSONA.md (operator identity)

If `.clawlite/PERSONA.md` exists, its content replaces `config.operator.persona` as the system prompt identity.

```markdown
# Harri

You are Harri, an AI operator built on ClawLite.

## Core behavior
- Direct, efficient, and transparent
- Always explain what you're doing and why
- Ask for approval before any external action

## Communication style
- Professional but not stiff
- Use bullet points for multi-item responses
- Keep responses concise — no filler
```

**Loading rules:**
- Max 1000 tokens. If the file exceeds this, truncate with a warning in logs.
- Loaded on every LLM call (chat path, worker prompts, operator prompts).
- Falls back to `config.operator.persona` if the file doesn't exist.
- **Power users can edit this file directly. Most users should never need to.**

### USER.md (user profile — conversation-managed)

USER.md stores the user's profile, contacts, and preferences. It is **populated during onboarding (Step 8)** and **updated through conversation** — the user should never need to open an editor.

```markdown
# User Profile

- Name: Paul
- Location: Miami, FL
- Business: 305 Locksmith LLC
- Role: Owner/operator
- Email tone: professional but direct, first-name basis
- Always include business name in email signatures
- Morning meetings preferred
- Works on: commercial door hardware, access control, security systems

## Key Contacts
- Branded Group — facility management vendor, Sarah handles onboarding
- Five Below — via ServiceChannel, district manager is John
- ServiceChannel — dispatch@servicechannel.com for work orders
```

**Updating via conversation:**
```text
Paul: Remember that my new contact at Branded Group is Mike, Sarah left.
Harri: ✅ Updated your profile — Branded Group contact changed from Sarah to Mike.

Paul: Forget about my preference for morning meetings.
Harri: ✅ Removed "morning meetings preferred" from your profile.

Paul: What do you know about me?
Harri: Here's your profile:
  - Name: Paul, Miami FL
  - Business: 305 Locksmith LLC
  - Contacts: Branded Group (Mike), Five Below (John), ServiceChannel
  - Preferences: professional/direct email tone, business name in signatures
  - Expertise: commercial door hardware, access control, security
```

**Implementation:**
```typescript
async function handleRememberCommand(msg: InboundMessage, adapter: ChannelAdapter) {
  const fact = msg.text.replace(/^\/remember\s+|^remember\s+that\s+/i, "").trim();

  // 1. Read current USER.md
  const currentProfile = readFileSafe(".clawlite/USER.md") ?? "";

  // 2. Use fast-tier LLM to update the profile intelligently
  const updated = await llm.complete({
    model: "fast",
    messages: [{
      role: "system",
      content: "You manage a user profile in Markdown format. Given the current profile and a new fact, return the updated profile. If the fact contradicts existing info, replace it. If it's new, add it to the appropriate section. Return only the updated Markdown, no explanations."
    }, {
      role: "user",
      content: `Current profile:\n${currentProfile}\n\nNew fact: ${fact}`
    }]
  });

  // 3. Write updated USER.md
  fs.writeFileSync(".clawlite/USER.md", updated.text);
  recordTokenUsage(updated.usage.total_tokens);

  // 4. Also store as semantic memory for FTS5 retrieval
  await ingestMemory({ type: "semantic", content: fact, tags: ["user_profile"] });

  await adapter.sendMessage(msg.chatId, {
    text: `✅ Got it — I'll remember that.`,
    parseMode: "plain"
  });
}

async function handleForgetCommand(msg: InboundMessage, adapter: ChannelAdapter) {
  const fact = msg.text.replace(/^\/forget\s+|^forget\s+(about\s+)?/i, "").trim();

  const currentProfile = readFileSafe(".clawlite/USER.md") ?? "";

  const updated = await llm.complete({
    model: "fast",
    messages: [{
      role: "system",
      content: "You manage a user profile in Markdown. Remove the specified fact from the profile. Return only the updated Markdown."
    }, {
      role: "user",
      content: `Current profile:\n${currentProfile}\n\nRemove: ${fact}`
    }]
  });

  fs.writeFileSync(".clawlite/USER.md", updated.text);
  recordTokenUsage(updated.usage.total_tokens);

  await adapter.sendMessage(msg.chatId, {
    text: `✅ Removed from your profile.`,
    parseMode: "plain"
  });
}
```

**Loading rules:**
- Max 500 tokens injected per prompt. Truncate with warning if exceeded.
- Loaded in chat path and worker prompts, **not** in group/shared contexts.
- Falls back gracefully if the file doesn't exist.

### HEARTBEAT.md (proactive checks — conversation-managed)

Defines what the heartbeat checks on each interval. **Populated during onboarding (Step 9)** and **managed through conversation.**

```markdown
# Heartbeat Checks

- Alert me if I get urgent emails from Branded Group or ServiceChannel
- Check if any calendar events today have conflicts
- On Monday mornings, prepare a weekly inbox summary
```

**Updating via conversation:**
```text
Paul: Add a heartbeat check: alert me if any invoice is overdue by more than 7 days
Harri: ✅ Added heartbeat condition. I'll check for overdue invoices every 30 minutes.

Paul: Remove the Monday weekly summary heartbeat
Harri: ✅ Removed "On Monday mornings, prepare a weekly inbox summary."

Paul: What heartbeat checks do I have?
Harri: Your heartbeat runs every 30 minutes and checks:
  1. Urgent emails from Branded Group or ServiceChannel
  2. Calendar conflicts today
  3. Invoices overdue by more than 7 days
```

**Implementation:**
```typescript
async function handleHeartbeatAdd(msg: InboundMessage, adapter: ChannelAdapter) {
  const condition = msg.text.replace(/^\/heartbeat\s+add\s+|^add\s+heartbeat\s+(check\s*:?\s*)?/i, "").trim();

  const currentChecks = readFileSafe(".clawlite/HEARTBEAT.md") ?? "# Heartbeat Checks\n";

  // Append new condition
  const updated = currentChecks.trimEnd() + `\n- ${condition}\n`;
  fs.writeFileSync(".clawlite/HEARTBEAT.md", updated);

  await adapter.sendMessage(msg.chatId, {
    text: `✅ Added heartbeat condition: "${condition}"`,
    parseMode: "plain"
  });
}

async function handleHeartbeatRemove(msg: InboundMessage, adapter: ChannelAdapter) {
  const toRemove = msg.text.replace(/^\/heartbeat\s+remove\s+|^remove\s+(the\s+)?heartbeat\s+(check\s*:?\s*)?/i, "").trim();

  const currentChecks = readFileSafe(".clawlite/HEARTBEAT.md") ?? "";

  const updated = await llm.complete({
    model: "fast",
    messages: [{
      role: "system",
      content: "Remove the specified condition from this heartbeat checklist. Return only the updated Markdown."
    }, {
      role: "user",
      content: `Current:\n${currentChecks}\n\nRemove: ${toRemove}`
    }]
  });

  fs.writeFileSync(".clawlite/HEARTBEAT.md", updated.text);
  recordTokenUsage(updated.usage.total_tokens);

  await adapter.sendMessage(msg.chatId, {
    text: `✅ Removed heartbeat condition.`,
    parseMode: "plain"
  });
}
```

See Section 8a for heartbeat execution details.

**Example `config.json` (generated by onboarding CLI — see Section 7):**
```json
{
  "operator": {
    "name": "Harri",
    "persona": "You are Harri, an AI operator. You are direct, efficient, and transparent."
  },
  "llm": {
    "provider": "openrouter",
    "tiers": {
      "fast": "google/gemini-3-flash",
      "balanced": "anthropic/claude-sonnet-4-6",
      "strong": "anthropic/claude-opus-4-6"
    }
  },
  "research": {
    "provider": "openrouter",
    "models": {
      "basic": "perplexity/sonar",
      "deep": "perplexity/sonar-deep-research"
    }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "allowedUserIds": [518293746]
    },
    "whatsapp": {
      "enabled": false
    },
    "discord": {
      "enabled": false,
      "allowedUserIds": []
    },
    "slack": {
      "enabled": false,
      "allowedUserIds": []
    },
    "webchat": {
      "enabled": true
    }
  },
  "tools": {
    "workspace": { "enabled": true },
    "research": { "enabled": true }
  },
  "budgets": {
    "dailyTokens": 200000,
    "perJobTokens": 50000,
    "maxToolCallsPerJob": 200
  },
  "hardLimits": {
    "maxNodesPerJob": 20,
    "maxTotalLLMCalls": 30,
    "maxJobDurationMs": 300000,
    "maxRetriesTotalPerJob": 10,
    "agenticMaxIterations": 5,
    "agenticMaxNodes": 10,
    "agenticMaxTokenBudget": 30000
  },
  "heartbeat": {
    "enabled": true,
    "intervalMinutes": 30,
    "model": "fast"
  },
  "http": {
    "enabled": true,
    "port": 18790,
    "host": "127.0.0.1"
  },
  "session": {
    "maxTurnsInMemory": 20,
    "turnsInjectedIntoChat": 5,
    "compactionThresholdTokens": 8000
  },
  "uploads": {
    "maxFileSizeMB": 25,
    "allowedTypes": ["document", "image", "audio"]
  }
}
```

**Note: API keys, tokens, and credentials are NOT in config.json.** They live in `.clawlite/.env` (see Section 15b). Config.json contains only non-sensitive configuration and can be safely committed to version control.

**The `llm` block is populated by the onboarding CLI, not hand-edited.** Users choose their provider and models interactively during setup. The `tiers` object maps abstract tier names to provider-specific model IDs. All templates and workers reference tiers, never model names.

---

## 5. TECHNOLOGY STACK

**Primary language:**
```
Node.js / TypeScript
```

**Required libraries:**
```
fastify
@fastify/websocket
@fastify/multipart
@fastify/static
better-sqlite3
dotenv
zod
openai
anthropic
axios
```

**Channel libraries (installed based on user selection):**
```
node-telegram-bot-api          — Telegram
@whiskeysockets/baileys        — WhatsApp
discord.js                     — Discord
@slack/bolt                    — Slack
```

**Core CLI dependencies:**
```
@googleworkspace/cli (gws) — Gmail, Calendar, Drive, Sheets, Docs, Chat
```

**Other dependencies:**
```
Perplexity API
```

**Deferred to v2:**
```
playwright (BrowserAgent)
Docker (optional sandboxing)
```

---

## 6. MAIN MODULES

| Module | Description |
|--------|-------------|
| `/cli` | Onboarding CLI (`clawlite setup`) |
| `/core` | Main runtime and event loop |
| `/llm` | Provider-agnostic LLM abstraction (tier resolution) |
| `/router` | Message classification (chat/command/complex) |
| `/planner` | Template graph selection, slot-filling, and bounded agentic fallback |
| `/executor` | Runs graph nodes and schedules workers |
| `/workers` | Sub-agent implementations |
| `/tools` | External integrations |
| `/memory` | Persistent structured memory (FTS5) |
| `/session` | Conversational session history and compaction |
| `/policies` | Security, permissions, budgets |
| `/ledger` | Full action log |
| `/channels` | Channel adapter layer (Telegram, WhatsApp, Discord, Slack) |
| `/http` | Fastify server (webhooks, artifact viewer, status API) |
| `/heartbeat` | Proactive condition checking |

---

## 7. MODEL TIERING (CRITICAL FOR COST CONTROL)

ClawLite uses three abstract model tiers. Users choose which specific model fills each tier during onboarding (see Section 7a). Templates and workers reference tiers, never vendor-specific model names.

### Tier definitions

| Tier | Purpose | Characteristics |
|------|---------|----------------|
| `fast` | Routing, classification, simple formatting, aggregation, heartbeat | Cheapest available, low latency, good at structured output |
| `balanced` | Research, email drafting, content creation, slot extraction, agentic fallback | Mid-range cost, good reasoning and tone |
| `strong` | Complex code generation, multi-step reasoning (v2) | Most capable, highest cost, used sparingly |

### Tier assignments by task

| Task | Tier | Rationale |
|------|------|-----------|
| Message routing/classification | `fast` | High accuracy for classification, minimal tokens |
| Simple chat responses | `fast` | Conversational, no tools needed |
| Template slot-filling | `fast` | Structured extraction from user message |
| Heartbeat condition check | `fast` | Single structured JSON response |
| Session compaction/summary | `fast` | Simple summarization task |
| Bounded agentic plan generation | `balanced` | Needs reasoning to create a valid plan |
| Research summarization | `balanced` | Needs quality reasoning |
| Email drafting | `balanced` | Needs tone and context awareness |
| Content creation (tweets, posts) | `balanced` | Needs creative quality |
| Code generation (v2) | `strong` | Needs deep reasoning |
| Code review (v2) | `balanced` | Needs analytical depth |
| Final job aggregation/summary | `fast` | Simple concatenation task |

### Node-level tier assignment

```typescript
interface TaskNode {
  // ... existing fields
  model: "fast" | "balanced" | "strong";  // abstract tier, resolved to provider model at runtime
}
```

### Runtime model resolution

```typescript
function resolveModel(tier: "fast" | "balanced" | "strong"): string {
  const modelId = config.llm.tiers[tier];
  if (!modelId) throw new Error(`No model configured for tier: ${tier}`);
  return modelId;
}
```

Workers call `resolveModel(node.model)` to get the actual provider-specific model ID. This means users can swap models at any time by editing `config.json` or re-running the onboarding CLI — no code changes, no template edits.

---

## 7a. ONBOARDING CLI (UPDATED — includes channel selection)

ClawLite includes an interactive onboarding CLI that runs on first install or via `clawlite setup`. It generates `config.json` by walking the user through each required setting.

### Onboarding flow

```text
$ clawlite setup

Welcome to ClawLite setup.

Step 1: Operator Identity
  What should your operator be called? [Harri]
  Describe your operator's personality: [You are Harri, an AI operator...]
  (Tip: You can customize further by editing .clawlite/PERSONA.md later.)

Step 2: LLM Provider
  Choose your LLM provider:
    1.  OpenRouter        (recommended — access to 200+ models with one API key)
    2.  Anthropic         (Claude Opus 4.6, Sonnet 4.6, Haiku 4.5)
    3.  OpenAI            (GPT-5.2, GPT-5.2 Pro, GPT-5 mini, GPT-5 nano)
    4.  Google AI Studio  (Gemini 3.1 Pro, Gemini 3 Flash, Gemini 2.5 Pro/Flash)
    5.  xAI               (Grok 4.1, Grok 4.1 Fast — 2M context window)
    6.  DeepSeek          (DeepSeek V3, DeepSeek R1 — ultra-low cost)
    7.  Mistral           (Mistral Large, Mistral Nemo, Magistral)
    8.  Groq              (ultra-fast inference — Llama, Mixtral)
    9.  Ollama / Local    (run models locally — Llama 4, Qwen, Mistral)
    10. Custom            (any OpenAI-compatible API endpoint)
  > 1

  Enter your OpenRouter API key: sk-or-v1-...
  Validating... ✓ API key valid (balance: $47.20)

Step 3: Model Selection
  ClawLite uses 3 model tiers to control costs.
  ~70% of calls use FAST (cheap), ~25% use BALANCED, ~5% use STRONG.

  FAST tier — routing, chat, heartbeat, aggregation (high volume, lowest cost):
    Suggested:
      • gemini-3-flash          $0.50/$3 per M tokens    — Google, fast + cheap
      • gpt-5-nano              $0.05/$0.40 per M tokens — OpenAI, ultra-cheap
      • gpt-5-mini              $0.25/$2 per M tokens    — OpenAI, great value
      • claude-haiku-4-5        $1/$5 per M tokens       — Anthropic, reliable
      • deepseek-v3             $0.14/$0.28 per M tokens — DeepSeek, cheapest reasoning
      • grok-4.1-fast           $0.20 per M tokens       — xAI, 2M context
      • minimax-m2.5            ~$0.10 per M tokens      — MiniMax, budget option
  > gemini-3-flash

  BALANCED tier — research, drafting, content creation, tool generation:
    Suggested:
      • claude-sonnet-4-6       $3/$15 per M tokens      — Anthropic, best all-rounder
      • gpt-5.2                 $1.75/$14 per M tokens   — OpenAI, strong reasoning
      • gemini-3.1-pro          $2/$12 per M tokens      — Google, competitive
      • gemini-2.5-pro          $1.25/$10 per M tokens   — Google, great value
      • grok-4.1                                         — xAI, strong reasoning
  > claude-sonnet-4-6

  STRONG tier — complex reasoning, code generation, multi-step analysis:
    Suggested:
      • claude-opus-4-6         $5/$25 per M tokens      — Anthropic, top benchmark scores
      • gpt-5.2-pro             $21/$168 per M tokens    — OpenAI, maximum capability
      • deepseek-r1             $0.55/$2.19 per M tokens — DeepSeek, best value reasoning
      • gemini-3.1-pro          $2/$12 per M tokens      — Google, strong + affordable
  > claude-opus-4-6

  ✓ Model tiers configured:
    fast:     gemini-3-flash        (~$0.50/M input)
    balanced: claude-sonnet-4-6     (~$3/M input)
    strong:   claude-opus-4-6       (~$5/M input)

Step 4: Messaging Channels
  Select one or more channels for ClawLite:
    [x] Telegram  — Bot token, easy setup
    [ ] WhatsApp  — QR code pairing, personal number
    [ ] Discord   — Bot token, server or DM
    [ ] Slack     — Bot + app token, workspace
    [x] WebChat   — Built-in browser UI, no external accounts needed
  > (select with space, confirm with enter)

  === Telegram Setup ===
  Enter your Telegram bot token: 123456:ABC...
  Enter your Telegram user ID (for allowlist): 123456789
  ✓ Bot connected.

  === WebChat Setup ===
  ✓ WebChat enabled at http://localhost:18790/chat
  ✓ Auth token generated and saved to config.

Step 5: Web Search & Research
  ClawLite uses Perplexity's Sonar models for web search and deep research.
  You can use your OpenRouter key (if selected above) or a dedicated Perplexity key.

  How would you like to access Perplexity models?
    1. Via OpenRouter (uses your existing OpenRouter key — simplest)
    2. Direct Perplexity API key (separate billing, may be cheaper for heavy research)
  > 1

  ✓ Research will use OpenRouter for Perplexity models.

  Select your research models:
    BASIC SEARCH (quick lookups, fact-checking):
      • sonar              $1/$1 per M tokens — fast, lightweight
      • sonar-pro          $3/$15 per M tokens — deeper context, better answers
    > sonar

    DEEP RESEARCH (comprehensive reports, multi-step analysis):
      • sonar-pro          $3/$15 per M tokens — good for most research
      • sonar-deep-research $2/$8 per M tokens + $5/1K searches + $3/M reasoning
                           Best for exhaustive research with full citations
    > sonar-deep-research

  ✓ Research models configured:
    basic:  perplexity/sonar
    deep:   perplexity/sonar-deep-research

Step 6: Google Workspace (Optional)
  Enables Gmail, Calendar, and Drive integration.
  
  Do you have Google Workspace credentials? [y/N]: y
  Credentials path: /Users/paul/.config/gws/credentials.json
  ✓ Google Workspace connected (Gmail, Calendar, Drive)

Step 7 of 11: Budgets
─────────────────────────────────
  Daily token budget — total tokens all agents can use in 24 hours.
  At your current model prices, 200K tokens ≈ $0.80/day typical usage.
  [200000]: 200000

  Per-job token budget — max tokens for a single job.
  [50000]: 50000

  ✓ Daily: 200,000 tokens | Per-job: 50,000 tokens


Step 8 of 11: Your Profile
─────────────────────────────────
  Tell Harri about yourself so it can personalize responses,
  draft emails in your voice, and know your business context.
  (You can update this anytime by telling Harri in chat.)

  Your name: Paul
  Your location: Miami, FL
  Your business/company: 305 Locksmith LLC
  Your role: Owner/operator

  Key contacts (one per line, blank line to finish):
    > Branded Group — facility management vendor, Sarah handles onboarding
    > Five Below — via ServiceChannel, district manager is John
    > ServiceChannel — dispatch@servicechannel.com for work orders
    >

  Email tone preference:
    1. Formal and professional
    2. Professional but direct (first-name basis)
    3. Casual and friendly
  > 2

  Anything else Harri should know about you?
  > I work on commercial door hardware, access control, and security systems.
    Morning meetings preferred. Always include business name in signatures.

  ✓ Profile saved to .clawlite/USER.md
  Tip: Tell Harri "remember that..." anytime to update your profile.


Step 9 of 11: Heartbeat (Optional)
─────────────────────────────────
  The heartbeat lets Harri proactively check conditions on a schedule
  and alert you or take action — without you asking.

  Enable heartbeat? [Y/n]: Y
  Check interval in minutes [30]: 30

  What should Harri check for? (one per line, blank line to finish):
    > Alert me if I get urgent emails from Branded Group or ServiceChannel
    > Check if any calendar events today have conflicts
    > On Monday mornings, prepare a weekly inbox summary
    >

  ✓ Heartbeat enabled (every 30 minutes)
  ✓ 3 conditions saved to .clawlite/HEARTBEAT.md
  Tip: Tell Harri "add heartbeat check: ..." anytime to add more.


Step 10 of 11: HTTP Server
─────────────────────────────────
  Enable webhooks + artifact viewer? [Y/n]: Y
  Port [18790]: 18790

  ✓ Server at http://127.0.0.1:18790
  ✓ Webhook token generated.


Step 11 of 11: Quick Tour
─────────────────────────────────
  Here's what you can tell Harri:

  📧 Email:     "check my inbox" or /inbox
  📅 Calendar:  "what's on today" or /today
  🔍 Research:  "research AI agents" or /research <topic>
  📢 Content:   "draft tweets about..." 
  📊 Status:    "what's your status" or /status
  🤖 Agents:    "show my agents" or /agents
  💰 Budget:    "how's the budget" or /budget
  🔧 Build:     "I need a marketing agent that..."
  💡 Remember:  "remember that my main client is..."
  💓 Heartbeat: "add heartbeat check: alert if..."
  📎 Files:     Drop any file in chat to use it

  Everything starts with a conversation. Just tell Harri what you need.


═══════════════════════════════════════════════════
  Setup Complete
═══════════════════════════════════════════════════

  ✓ .clawlite/config.json     (non-sensitive config)
  ✓ .clawlite/.env            (API keys — never commit this)
  ✓ .clawlite/.gitignore      (protects .env)
  ✓ .clawlite/clawlite.db    (database initialized)
  ✓ .clawlite/PERSONA.md     (Harri's personality — editable)
  ✓ .clawlite/USER.md        (your profile — update via chat)
  ✓ .clawlite/HEARTBEAT.md   (proactive checks — update via chat)
  ✓ .clawlite/templates/     (8 built-in templates)

  Default sub-agents: inbox, calendar, research, publisher

  Run:  clawlite start            (foreground)
        clawlite start --daemon   (background, auto-restarts)

═══════════════════════════════════════════════════
```

### Provider configuration (UPDATED — supports all major providers)

```typescript
type LLMProvider =
  | "openrouter"
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "deepseek"
  | "mistral"
  | "groq"
  | "ollama"
  | "custom";

interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  baseUrl?: string;    // required for "ollama" and "custom"
  tiers: {
    fast: string;      // provider-specific model ID
    balanced: string;
    strong: string;
  };
}

interface ResearchConfig {
  provider: "openrouter" | "perplexity";  // which API to route Sonar calls through
  apiKey?: string;    // only needed if provider is "perplexity" (dedicated key)
  models: {
    basic: string;    // e.g. "perplexity/sonar"
    deep: string;     // e.g. "perplexity/sonar-deep-research"
  };
}
```

### Provider resolution (UPDATED)

All LLM calls go through a single `llm.complete()` function that resolves the provider from config:

```typescript
async function complete(params: {
  model: "fast" | "balanced" | "strong";
  messages: Message[];
  format?: "json" | "text";
}): Promise<LLMResponse> {
  const modelId = config.llm.tiers[params.model];
  const provider = config.llm.provider;

  switch (provider) {
    case "openrouter":
      return callOpenRouter(modelId, params);
    case "anthropic":
      return callAnthropic(modelId, params);
    case "openai":
      return callOpenAI(modelId, params);
    case "google":
      return callGoogleAI(modelId, params);
    case "xai":
      return callOpenAICompatible("https://api.x.ai/v1", modelId, params);
    case "deepseek":
      return callOpenAICompatible("https://api.deepseek.com/v1", modelId, params);
    case "mistral":
      return callMistral(modelId, params);
    case "groq":
      return callOpenAICompatible("https://api.groq.com/openai/v1", modelId, params);
    case "ollama":
      return callOpenAICompatible(config.llm.baseUrl ?? "http://localhost:11434/v1", modelId, params);
    case "custom":
      return callOpenAICompatible(config.llm.baseUrl!, modelId, params);
  }
}
```

### Re-running setup

Users can re-run `clawlite setup` at any time to change provider, swap models, add/remove channels, or update API keys. The CLI preserves existing config values as defaults so users only change what they need.

---

## 7b. CLI COMMAND REFERENCE (NEW)

ClawLite is controlled entirely from the terminal. The CLI handles daemon management, configuration, diagnostics, maintenance, and direct agent interaction. All commands use the `clawlite` binary installed via `npm install -g clawlite`.

### Daemon management

| Command | Description |
|---------|-------------|
| `clawlite start` | Start in **foreground** — logs to stdout, Ctrl+C to stop. Use for development and debugging. |
| `clawlite start --daemon` | Start as a **background daemon**. Installs and starts a launchd (macOS) or systemd (Linux) user service. Survives SSH disconnect, auto-restarts on crash. |
| `clawlite stop` | Gracefully stop the daemon. Finishes running nodes, persists state, disconnects all channels, then exits. |
| `clawlite restart` | Stop then start. Equivalent to `clawlite stop && clawlite start --daemon`. |
| `clawlite status` | Check if the daemon is running. Shows uptime, active jobs, budget usage, connected channels, last heartbeat. |

#### Foreground vs daemon mode

**Foreground (`clawlite start`)** is for development. You see structured JSON logs in real time, Ctrl+C sends SIGINT for graceful shutdown, and the process dies when you close the terminal. This is what you use when building, debugging, or running on a machine you're sitting in front of.

**Daemon (`clawlite start --daemon`)** is for production. On macOS it creates a `~/Library/LaunchAgents/com.clawlite.gateway.plist` file and loads it via `launchctl`. On Linux it creates a `~/.config/systemd/user/clawlite.service` file and enables it via `systemctl --user`. The service auto-restarts on crash with a 5-second delay.

```typescript
// Service installation (runs once on first `--daemon`)
async function installDaemonService() {
  const platform = process.platform;

  if (platform === "darwin") {
    const plist = generateLaunchdPlist({
      label: "com.clawlite.gateway",
      program: process.execPath,
      args: [clawliteBinPath, "start"],
      workingDirectory: getClawliteHome(),
      keepAlive: true,
      standardOutPath: `${getClawliteHome()}/logs/daemon.log`,
      standardErrorPath: `${getClawliteHome()}/logs/daemon.err`
    });
    const plistPath = path.join(os.homedir(), "Library/LaunchAgents/com.clawlite.gateway.plist");
    fs.writeFileSync(plistPath, plist);
    execSync(`launchctl load ${plistPath}`);
    console.log("✓ Daemon installed and started (launchd)");

  } else if (platform === "linux") {
    const unit = generateSystemdUnit({
      description: "ClawLite AI Operator",
      execStart: `${process.execPath} ${clawliteBinPath} start`,
      workingDirectory: getClawliteHome(),
      restart: "on-failure",
      restartSec: 5
    });
    const unitDir = path.join(os.homedir(), ".config/systemd/user");
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(unitDir, "clawlite.service"), unit);
    execSync("systemctl --user daemon-reload");
    execSync("systemctl --user enable --now clawlite.service");
    console.log("✓ Daemon installed and started (systemd)");

  } else if (platform === "win32") {
    // Windows: use pm2 or node-windows as a fallback
    console.log("On Windows, use `clawlite start` in a terminal, or install pm2:");
    console.log("  npm install -g pm2");
    console.log("  pm2 start clawlite -- start");
    console.log("  pm2 save && pm2 startup");
  }
}
```

#### Graceful shutdown

When `clawlite stop` is called (or SIGINT/SIGTERM is received):

```typescript
async function gracefulShutdown() {
  console.log("[ClawLite] Shutting down...");

  // 1. Stop heartbeat scheduler
  stopHeartbeat();

  // 2. Stop accepting new messages from all channels
  await channelRegistry.stopAll();

  // 3. Wait for running nodes to complete (max 30 seconds)
  const runningJobs = db.getJobsByStatus(["running"]);
  if (runningJobs.length > 0) {
    console.log(`[ClawLite] Waiting for ${runningJobs.length} running job(s) to finish (max 30s)...`);
    await waitForJobCompletion(runningJobs, 30000);
  }

  // 4. Mark any still-running nodes as interrupted (they'll resume on restart)
  db.markRunningNodesAsInterrupted();

  // 5. Close HTTP server
  await fastify.close();

  // 6. Close database
  db.close();

  console.log("[ClawLite] Shutdown complete.");
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
```

#### Status output

```text
$ clawlite status

ClawLite v1.0.0 — Harri is online

  Uptime:        4h 23m
  PID:           48291
  Mode:          daemon (launchd)

  Channels:
    ✅ telegram     connected (polling)
    ✅ webchat      listening on http://127.0.0.1:18790/chat
    ⬚  whatsapp     disabled
    ⬚  discord      disabled
    ⬚  slack        disabled

  Budget:
    Today:         34,210 / 200,000 tokens (17.1%)
    Resets:        in 7h 12m

  Jobs:
    Active:        1 (job a3f2... — running, 3/5 nodes complete)
    Waiting:       0 approvals pending
    Today total:   12 jobs (11 completed, 1 running)

  Heartbeat:
    Last check:    12 minutes ago
    Next check:    in 18 minutes
    Last action:   triggered inbox_assistant at 09:30

  HTTP server:    http://127.0.0.1:18790
```

### Configuration commands

| Command | Description |
|---------|-------------|
| `clawlite setup` | Full onboarding wizard (interactive) |
| `clawlite setup --channel <name>` | Re-run setup for one channel only |
| `clawlite setup --models` | Re-run model tier selection only |
| `clawlite setup --budgets` | Re-run budget configuration only |
| `clawlite config get <key>` | Read a config value (dot notation) |
| `clawlite config set <key> <value>` | Set a config value |
| `clawlite config show` | Print full config (secrets redacted) |
| `clawlite config validate` | Validate config.json against schema |

```text
$ clawlite config get llm.tiers.fast
openrouter/minimax/minimax-m2.5

$ clawlite config set budgets.dailyTokens 300000
✓ budgets.dailyTokens → 300000
⚠ Restart required for changes to take effect.

$ clawlite config show
{
  "operator": { "name": "Harri", "persona": "..." },
  "llm": {
    "provider": "openrouter",
    "apiKey": "sk-or-***REDACTED***",
    "tiers": {
      "fast": "openrouter/minimax/minimax-m2.5",
      "balanced": "openrouter/anthropic/claude-sonnet-4-20250514",
      "strong": "openrouter/anthropic/claude-opus-4-20250514"
    }
  },
  ...
}
```

**Hot-reloadable settings** (no restart needed): `budgets.*`, `hardLimits.*`, `heartbeat.intervalMinutes`, `heartbeat.enabled`. The daemon watches `config.json` for changes and reloads these values automatically.

**Restart-required settings**: `llm.*`, `channels.*`, `http.port`, `http.host`.

### Diagnostic commands

| Command | Description |
|---------|-------------|
| `clawlite logs` | Tail recent logs (last 50 lines) |
| `clawlite logs --follow` | Live tail (like `tail -f`) |
| `clawlite logs --level error` | Filter by log level (`debug`, `info`, `warn`, `error`) |
| `clawlite logs --since 1h` | Logs from the last hour (`1h`, `30m`, `1d`) |
| `clawlite jobs` | List recent jobs (last 20) |
| `clawlite jobs --status running` | Filter by status |
| `clawlite job <id>` | Show job detail: nodes, status, cost, duration |
| `clawlite budget` | Show daily budget usage |
| `clawlite memory` | List recent memory items (last 20) |
| `clawlite memory search <query>` | Search memory via FTS5 |
| `clawlite memory count` | Show memory item count by type |

```text
$ clawlite jobs
ID        Status     Type       Trigger    Cost     Duration  Goal
a3f2c1d8  running    template   telegram   12,340   45s       Check inbox and draft replies
b7e9f042  completed  template   heartbeat   4,120   12s       Inbox check (heartbeat)
c1a3d567  completed  template   telegram    8,900   28s       Research AI agents
d4f8e901  completed  agentic    webchat    22,100   1m 03s    Analyze competitor pricing
...

$ clawlite job a3f2c1d8
Job a3f2c1d8 — Check inbox and draft replies
  Status:    running
  Type:      template (inbox_assistant)
  Trigger:   telegram (chat 123456789)
  Budget:    12,340 / 50,000 tokens
  Duration:  45s
  Dry run:   no

  Nodes:
    ✅ 1. gmail.list        → WorkspaceAgent [fast]     1,200 tokens   3s
    ✅ 2. gmail.summarize   → WorkspaceAgent [balanced]  6,800 tokens   18s
    ⚙️ 3. gmail.draft       → WorkspaceAgent [balanced]  4,340 tokens   24s (running)
    ⏳ 4. aggregate         → AggregatorAgent [fast]     pending

$ clawlite budget
Daily token budget:
  Window start:   2026-03-06 00:00 UTC
  Consumed:       34,210 tokens
  Remaining:      165,790 tokens
  Limit:          200,000 tokens
  Resets in:      7h 12m
  Usage:          ██████░░░░░░░░░░░░░░ 17.1%

$ clawlite memory search "Five Below"
ID          Type       Created     Content
mem_a1b2    semantic   2d ago      Five Below district manager is John, access via ServiceChannel
mem_c3d4    episodic   5d ago      Completed cold call script for Five Below DM
```

### Maintenance commands

| Command | Description |
|---------|-------------|
| `clawlite reset --sessions` | Clear all session history (conversational turns) |
| `clawlite reset --memory` | Clear all memory items |
| `clawlite reset --memory-type episodic` | Clear only episodic memories |
| `clawlite reset --jobs` | Clear job history (completed jobs and their artifacts) |
| `clawlite reset --all` | Nuclear option — reset everything except config.json |
| `clawlite db backup` | Copy SQLite database to `.clawlite/backups/clawlite_YYYYMMDD_HHMMSS.db` |
| `clawlite db vacuum` | Run SQLite VACUUM to reclaim disk space |
| `clawlite db stats` | Show database size, table row counts |

**All destructive commands require confirmation:**

```text
$ clawlite reset --memory
⚠ This will permanently delete all 247 memory items.
  - 180 episodic
  -  42 semantic
  -  25 procedural

Are you sure? Type 'yes' to confirm: yes
✓ Memory cleared.

$ clawlite reset --all
⚠ This will permanently delete:
  - 247 memory items
  - 1,342 session turns
  - 89 jobs and their artifacts
  - All ledger entries
  - Daily budget counter (will reset)

  Config.json will NOT be deleted.

Are you sure? Type 'yes' to confirm:
```

### Testing & interaction commands

| Command | Description |
|---------|-------------|
| `clawlite send "<message>"` | Send a message to the agent from the terminal and see the response. Routes through the same router as channel messages. |
| `clawlite dryrun "<goal>"` | Run a job in dry-run mode from the terminal. No external side effects. |
| `clawlite templates` | List all available template graphs |
| `clawlite template <id>` | Show template detail (nodes, slots, model tiers) |
| `clawlite tools` | List all registered tools and their status |
| `clawlite heartbeat --now` | Trigger a heartbeat check immediately (don't wait for the interval) |

### Tool installation & management commands

| Command | Description |
|---------|-------------|
| `clawlite tool install <source>` | Install a tool from GitHub, MCP registry, or local path (runs security analysis) |
| `clawlite tool list` | List all installed tools with source, version, risk, and status |
| `clawlite tool info <name>` | Show tool detail: permissions, actions, security score, install source |
| `clawlite tool update <name>` | Update to latest version (re-runs security analysis, requires approval) |
| `clawlite tool update --all` | Update all installed custom tools |
| `clawlite tool remove <name>` | Uninstall a custom tool |
| `clawlite tool scan <name>` | Re-run security analysis on an installed tool |
| `clawlite tool scan --all` | Re-run security analysis on all custom tools |
| `clawlite tool audit` | Show security report for all installed custom tools |

See `TOOL_SDK.md` Section 14a for the full security analysis pipeline, check definitions, and installation flow.

```text
$ clawlite send "what's on my calendar today?"
Routing: chat → fast tier
Harri: You have 3 events today:
  - 10:00 AM — Standup with team
  - 2:00 PM — Five Below call with John
  - 4:30 PM — Dentist appointment

$ clawlite dryrun "check inbox and draft replies"
[DRY RUN] Job d9e1f234 started (template: inbox_assistant)
  ✅ gmail.list        → [dry_run] Would list 20 unread emails
  ✅ gmail.summarize   → [dry_run] Would summarize threads
  ✅ gmail.draft       → [dry_run] Would draft replies
  ✅ aggregate         → [dry_run] Would format summary
[DRY RUN] Job complete. 0 tokens consumed. No external actions taken.

$ clawlite templates
ID                  Trigger          Nodes  Description
inbox_assistant     /inbox           3      List and summarize unread emails
draft_reply         /draft           3      Draft a reply to an email thread
send_email          /send            1      Send a drafted email
todays_calendar     /today           2      Show today's calendar events
schedule_event      /schedule        1      Create a calendar event
deep_research       /research        3      Run deep research on a topic
research_to_posts   (freeform)       4      Research a topic and draft social posts
email_calendar_combo (freeform)      6      Check email and schedule follow-ups

$ clawlite tools
Name        Status    Risk     Actions
workspace   enabled   medium   gmail.list, gmail.get, gmail.draft, gmail.send, calendar.list, calendar.create, ...
research    enabled   low      search, deep
fs          enabled   low      readText, writeText, listDir

$ clawlite heartbeat --now
Running heartbeat check...
Checking HEARTBEAT.md (3 conditions)...
Result: { action: "trigger", templateId: "inbox_assistant", reason: "2 urgent unread emails from key contacts" }
Job e5f6a789 created and started.
```

### `clawlite send` — terminal as a channel

`clawlite send` routes through the same message router as any channel message. This is useful for:
- Testing the agent without opening a chat app
- Scripting interactions from cron or other tools
- Quick one-off commands from SSH

```typescript
async function handleCLISend(message: string) {
  // Create a virtual "cli" channel context
  const inbound: InboundMessage = {
    channelName: "cli",
    chatId: "cli_session",
    userId: "cli_user",
    text: message,
    timestamp: Date.now(),
    raw: {}
  };

  // Route through the same handler as any channel
  const intent = await routeMessage(message);

  switch (intent) {
    case "chat":
      const response = await handleChatAndReturnText(inbound);
      console.log(`${config.operator.name}: ${response}`);
      break;
    case "command":
      const result = await handleCommandAndReturnText(inbound);
      console.log(result);
      break;
    case "complex":
      console.log("Starting job...");
      const job = await handleComplexAndReturnJob(inbound);
      // Poll for completion and print progress
      await printJobProgress(job.id);
      break;
  }
}
```

For complex jobs, `clawlite send` prints progress to stdout in real time and blocks until the job completes (or times out). Approvals are presented as terminal prompts:

```text
$ clawlite send "draft a reply to the Branded Group email and send it"
Routing: complex → template: draft_reply
⚙️ Fetching thread...
✅ Thread fetched (3 messages)
⚙️ Drafting reply...
✅ Draft ready

📧 Approval Required
Action: Send email to onboarding@brandedgroup.com
Subject: Re: Vendor onboarding timeline

  Hi Sarah,

  Thanks for sending over the requirements. I've reviewed
  the documentation and can confirm we meet all insurance
  and licensing thresholds...

Approve? [y/n/r(evise)]: y
✅ Email sent.
```

### Exit codes

All CLI commands return meaningful exit codes for scripting:

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Config invalid or missing (run `clawlite setup`) |
| 3 | Daemon not running (for commands that require it) |
| 4 | Budget exhausted |
| 5 | Auth failure (invalid API key, expired credentials) |

### Module structure

```text
/cli/index.ts              — command parser and dispatcher
/cli/setup.ts              — onboarding wizard (clawlite setup)
/cli/daemon.ts             — start/stop/restart/status + service installation
/cli/config.ts             — config get/set/show/validate
/cli/logs.ts               — log tailing and filtering
/cli/jobs.ts               — job listing and detail
/cli/budget.ts             — budget display
/cli/memory.ts             — memory listing, search, count
/cli/reset.ts              — destructive reset commands (with confirmation)
/cli/db.ts                 — backup, vacuum, stats
/cli/send.ts               — terminal message sending
/cli/dryrun.ts             — dry run from terminal
/cli/templates.ts          — template listing and detail
/cli/tools.ts              — tool listing
/cli/heartbeat.ts          — manual heartbeat trigger
/cli/validateConfig.ts     — config schema validation
```

---

## 8. EVENT SYSTEM

ClawLite wakes only when events occur.

**Supported events:**
```
channel_message      ← renamed from telegram_message (any channel)
cron_trigger
webhook_event        ← NEW: external HTTP trigger
heartbeat_trigger    ← NEW: proactive check
file_upload
system_event
```

**Event structure:**
```json
{
  "type": "string",
  "source": "string",
  "channelId": "string",
  "payload": "object",
  "timestamp": "number"
}
```

The `source` field identifies which channel or system produced the event (e.g., `"telegram"`, `"whatsapp"`, `"webhook"`, `"heartbeat"`, `"cron"`).

---

## 8a. HEARTBEAT SYSTEM (NEW)

The heartbeat provides proactive behavior without an open-ended agentic loop. It runs on a configurable interval, checks conditions defined in `HEARTBEAT.md`, and triggers work through the normal template system if any condition needs action.

### How it works

1. Timer fires every `config.heartbeat.intervalMinutes` (default 30)
2. Read `HEARTBEAT.md` from workspace
3. Single `fast` tier LLM call with the checklist and current context (time, day of week)
4. LLM returns structured JSON — either no action needed or a template to trigger
5. If action needed, create a normal job through `createJobFromTemplate()`
6. All budget/circuit-breaker rules apply — heartbeat is not exempt

### Heartbeat response schema

```typescript
interface HeartbeatResult {
  action: "none" | "trigger";
  templateId?: string;
  slots?: Record<string, any>;
  reason?: string;
}
```

### Heartbeat execution

```typescript
async function runHeartbeat() {
  // Budget check — heartbeat is NOT exempt
  const budgetCheck = checkDailyBudget(500);
  if (!budgetCheck.ok) {
    logger.info("Heartbeat skipped: daily budget exhausted");
    return;
  }

  const checklist = readFileSync(".clawlite/HEARTBEAT.md", "utf-8");
  if (!checklist.trim()) return;

  const result = await llm.complete({
    model: "fast",
    messages: [{
      role: "system",
      content: "You are a condition checker. Given the checklist below, determine if any condition requires action RIGHT NOW. Respond with JSON only."
    }, {
      role: "user",
      content: `Current time: ${new Date().toISOString()}\nDay: ${getDayOfWeek()}\n\nChecklist:\n${checklist}\n\nAvailable templates: ${templateSummary()}\n\nRespond: { "action": "none" } or { "action": "trigger", "templateId": "...", "slots": {...}, "reason": "..." }`
    }],
    format: "json"
  });

  recordTokenUsage(result.usage.total_tokens);

  if (result.parsed.action === "trigger" && result.parsed.templateId) {
    const template = templates.get(result.parsed.templateId);
    if (!template) {
      logger.warn(`Heartbeat wanted template ${result.parsed.templateId} but it doesn't exist`);
      return;
    }

    // Determine which channel to notify — use the first enabled channel's default chat
    const notifyChannel = getDefaultNotificationChannel();

    const job = await createJobFromTemplate(template, result.parsed.slots ?? {}, {
      triggerType: "heartbeat",
      channelId: notifyChannel.id,
      chatId: notifyChannel.defaultChatId,
      dryRun: false
    });

    logger.info(`Heartbeat triggered job ${job.id}: ${result.parsed.reason}`);
  }
}
```

### Cost estimate

One `fast` tier call every 30 minutes ≈ ~100 tokens × 48 calls/day = ~4,800 tokens/day. Negligible compared to actual work.

### Difference from OpenClaw's heartbeat

OpenClaw runs a **full agentic loop** on each heartbeat — the LLM can call tools, write files, send messages autonomously. ClawLite's heartbeat is a **single classification call** that can only trigger existing template graphs through the normal job system. Same proactive UX, none of the runaway risk.

---

## 9. TASK GRAPH ENGINE

All jobs are executed as Directed Acyclic Graphs (DAG).

**Graph node structure:**
```typescript
Node {
  id: string
  type: string
  status: pending | running | completed | failed
  dependencies: string[]
  agent: string
  model: string
  input: object
  output: object
  tool_permissions: string[]
  requires_approval: boolean
}
```

**Execution rules:**
- Nodes run when dependencies are complete
- Nodes without dependencies run immediately
- Nodes may execute in parallel
- Failure triggers retry or halt

See `TASKGRAPH_ENGINE.md` for full specification.

---

## 10. AGENT MODEL — OPERATOR AS ORCHESTRATOR

ClawLite uses a **hierarchical operator model** where a single Operator Agent manages a growing team of specialized sub-agents. The operator doesn't just dispatch pre-built templates — it understands what the user needs, builds the capabilities to deliver it, and delegates execution to the right sub-agent.

### 10.1 Architecture hierarchy

```
┌─────────────────────────────────────────────────────────────┐
│                      OPERATOR AGENT                          │
│  Routes messages, understands intent, builds capabilities,   │
│  creates sub-agents, supervises execution, manages budgets   │
└──────┬──────────────┬───────────────┬───────────────┬───────┘
       │              │               │               │
  ┌────▼────┐   ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼─────┐
  │ Inbox   │   │ Content   │  │ Marketing │  │  Support  │
  │ Agent   │   │ Agent     │  │ Team      │  │  Agent    │
  │         │   │           │  │           │  │           │
  │ gmail   │   │ research  │  │ meta-ads  │  │ gmail     │
  │ calendar│   │ twitter   │  │ image-gen │  │ templates │
  │ drive   │   │ linkedin  │  │ landing   │  │ crm       │
  └─────────┘   └───────────┘  └───────────┘  └───────────┘
   (built-in)   (user-created)  (user-created)  (user-created)
```

### 10.2 Operator Agent

The Operator is always running. There is exactly one per ClawLite instance. It is the only agent that talks directly to the user.

**Responsibilities:**
- Route all incoming messages (chat/command/complex)
- Interpret user intent — including requests to build new capabilities
- Delegate work to the right sub-agent based on the request
- **Create new sub-agents** when the user needs capabilities that don't exist yet
- **Generate new tools** when a sub-agent needs to connect to a new API or service
- **Author new template graphs** when a sub-agent needs a new workflow
- Select and populate template graphs for known workflows
- Invoke bounded agentic fallback for unmatched requests
- Supervise all sub-agent execution
- Manage budgets across all sub-agents
- Deliver results to the user
- Handle approvals for all sub-agents

**What the Operator does NOT do:**
- Execute graph nodes (that's what sub-agents do)
- Hold persistent state (all state lives in SQLite)
- Run tools directly (tools are invoked by workers within sub-agent jobs)

**Model usage:** The Operator uses `fast` for routing and classification, `balanced` for building new capabilities (tool generation, template authoring, sub-agent creation). It should almost never use `strong` — its job is coordination and construction, not deep reasoning.

### 10.3 Sub-Agents (dynamic — created on demand)

Sub-agents are specialized executors created by the Operator when the user needs new capabilities. Each sub-agent is defined by a **profile** stored in the database, not hardcoded.

```typescript
interface SubAgent {
  id: string;
  name: string;                     // "Marketing Team", "Content Agent", "Support Agent"
  description: string;              // what this sub-agent does
  persona: string;                  // system prompt for this sub-agent's workers
  tools: string[];                  // which tools this sub-agent can use
  templates: string[];              // which template graphs this sub-agent owns
  defaultTier: "fast" | "balanced" | "strong";
  budgetTokensDaily: number;        // sub-agent's own daily budget (carved from global)
  cronJobs: CronDefinition[];       // scheduled work for this sub-agent
  heartbeatConditions: string[];    // proactive checks specific to this sub-agent
  status: "active" | "paused" | "disabled";
  createdAt: number;
  createdBy: "operator" | "user";   // who created it — operator (via conversation) or user (via CLI)
}
```

**Built-in sub-agents (ship with ClawLite):**

| Sub-Agent | Tools | Templates | Description |
|-----------|-------|-----------|-------------|
| `inbox` | workspace | inbox_assistant, draft_reply, send_email | Gmail management |
| `calendar` | workspace | todays_calendar, schedule_event | Calendar management |
| `research` | research | deep_research | Web research via Perplexity |
| `publisher` | research | research_to_posts | Research and draft social content |

These are created automatically during onboarding if the user enables the corresponding tools. They can be modified or removed like any other sub-agent.

**User-created sub-agents (examples):**

| Sub-Agent | Tools (generated) | Templates (generated) | Description |
|-----------|-------------------|----------------------|-------------|
| `marketing` | meta-ads, image-gen, landing-page | create_campaign, analyze_performance, optimize_ads | Full marketing team |
| `blog-writer` | wordpress, image-gen, seo-tool | write_post, optimize_seo, schedule_publish | Blog content pipeline |
| `sales` | hubspot, gmail-templates, calendar | qualify_lead, send_outreach, schedule_demo | Sales outreach automation |
| `bookkeeper` | quickbooks, stripe, invoice-gen | reconcile_transactions, generate_invoice, monthly_report | Financial management |

### 10.4 Worker Agents (executors within sub-agents)

Workers are the hands that execute graph nodes. They are stateless and domain-specific.

**Core workers (always available):**

| Worker | Role |
|--------|------|
| `WorkspaceAgent` | Google Workspace operations (gmail, calendar, drive) |
| `ResearchAgent` | Web and deep research |
| `PublisherAgent` | Output delivery and posting |
| `AggregatorAgent` | Format upstream artifacts into user summary |
| `BuilderAgent` | **Generate tools, templates, and sub-agent configs** (NEW — see Section 10a) |

**How workers relate to sub-agents:** A sub-agent owns templates and tools. When a sub-agent's template runs, its nodes are dispatched to the appropriate worker based on node type. The worker uses the sub-agent's persona and tool permissions. Multiple sub-agents can share the same workers — for example, both the "inbox" and "support" sub-agents use the WorkspaceAgent to interact with Gmail.

### 10.5 Budget hierarchy

Budgets cascade from global to sub-agent to job:

```
Global daily budget (200,000 tokens)
├── Operator overhead (~10,000 tokens/day — routing, chat, building)
├── inbox sub-agent (50,000 tokens/day)
│   ├── job: morning inbox check (12,000 tokens)
│   └── job: draft replies (8,000 tokens)
├── content sub-agent (40,000 tokens/day)
│   └── job: daily tweet generation (15,000 tokens)
├── marketing sub-agent (80,000 tokens/day)
│   ├── job: daily performance analysis (20,000 tokens)
│   └── job: creative generation (35,000 tokens)
└── unallocated (20,000 tokens — buffer for ad-hoc requests)
```

Sub-agent budgets are **advisory, not hard limits** for MVP. The global daily budget and per-job circuit breakers are the hard limits. In v2, sub-agent budgets become enforced ceilings.

---

## 10a. SELF-BUILDING CAPABILITIES (NEW — CRITICAL)

The Operator Agent can build new capabilities through conversation. This is what makes ClawLite a general-purpose platform rather than a fixed-capability assistant.

### What the Operator can build

| Capability | How it works | User approval required? |
|------------|-------------|----------------------|
| **New tool** | Generates TypeScript tool file, runs security analysis, installs | Yes — user sees security report and approves |
| **New template** | Generates YAML template definition, validates DAG structure, saves | Yes — user reviews the workflow steps |
| **New sub-agent** | Creates a profile combining persona + tools + templates + schedule | Yes — user reviews the configuration |
| **New cron job** | Attaches a schedule to an existing template within a sub-agent | Yes — user confirms the schedule |
| **New heartbeat condition** | Adds a condition to a sub-agent's heartbeat checks | Yes — user confirms the condition |

### Building flow — example: "I want a marketing agent"

```text
User: I want to set up a marketing agent that monitors my Facebook ad 
      performance, creates new ad creatives when ROAS drops, and tests 
      landing pages.

Operator (thinking — balanced tier):
  1. User wants a marketing sub-agent
  2. Needs tools: Meta Ads API, image generation, landing page builder
  3. Needs templates: analyze_performance, generate_creatives, test_landing_pages
  4. Needs heartbeat: check ROAS daily
  5. None of these exist yet — need to build them

Operator: I can set that up for you. Here's what I'll need to create:

  📦 New tools (3):
  1. meta-ads — connects to Facebook Marketing API 
     (needs your Meta Business access token)
  2. image-gen — generates ad creatives via DALL-E API
     (needs your OpenAI API key)
  3. landing-page — builds and deploys landing pages via Vercel
     (needs your Vercel token)

  📋 New workflows (3):
  1. Analyze Performance — pull metrics → analyze → generate report
  2. Generate Creatives — get underperforming ads → generate new copy + images → approval
  3. Test Landing Pages — create variant → deploy → monitor → report results

  🤖 New sub-agent:
  Name: "Marketing Team"
  Schedule: Daily performance check at 8 AM
  Heartbeat: Alert if any campaign ROAS drops below 2.0

  Shall I proceed? I'll need your API keys for Meta, OpenAI, and Vercel.

User: Yes, let's do it. My Meta token is... [provides keys]

Operator: Building your marketing team...

  ⚙️ Generating meta-ads tool...
  🔒 Security analysis: 8/10 (1 warning: NET_ACCESS to graph.facebook.com)
  ✅ meta-ads tool ready — approve installation? [y/n]

User: y

  ⚙️ Generating image-gen tool...
  🔒 Security analysis: 9/10 (1 warning: NET_ACCESS to api.openai.com)
  ✅ image-gen tool ready — approve installation? [y/n]

User: y

  ⚙️ Generating landing-page tool...
  🔒 Security analysis: 8/10 (1 warning: NET_ACCESS to api.vercel.com)
  ✅ landing-page tool ready — approve installation? [y/n]

User: y

  📋 Creating workflow: Analyze Performance
     1. meta-ads.get_campaigns → [fast]
     2. meta-ads.get_metrics → [fast]  
     3. analyze_results → [balanced]
     4. generate_report → [balanced]
     5. aggregate → [fast]
  ✅ Workflow ready — approve? [y/n]

User: y

  [... similar for other workflows ...]

  🤖 Creating sub-agent: Marketing Team
     Persona: "You are a performance marketing specialist..."
     Tools: meta-ads, image-gen, landing-page
     Templates: analyze_performance, generate_creatives, test_landing_pages
     Schedule: Daily at 8 AM — analyze_performance
     Heartbeat: Alert if ROAS < 2.0
     Budget: 80,000 tokens/day
  ✅ Sub-agent ready — approve? [y/n]

User: y

✅ Marketing Team is live.
  - Daily performance check scheduled for 8 AM
  - Heartbeat monitoring ROAS threshold
  - Say "check ad performance" or "create new ads" anytime
```

### 10a.1 Tool generation

The Operator uses the BuilderAgent to generate tool files. The BuilderAgent:

1. Receives the API description from the user (or researches it via the ResearchAgent)
2. Generates a TypeScript file following the ToolDefinition interface (TOOL_SDK.md Section 4)
3. Includes Zod schemas for all parameters
4. Declares permissions for each action
5. Sets approval gates on dangerous actions (create, delete, send, publish, deploy)
6. Includes a mockHandler for dry run support
7. The generated file goes through the **full security analysis pipeline** (TOOL_SDK.md Section 14a)
8. User must approve after seeing the security report

```typescript
// The Operator delegates tool generation to the BuilderAgent
async function generateTool(request: {
  name: string;
  apiDescription: string;
  apiBaseUrl: string;
  actions: { name: string; description: string; risk: ToolRisk }[];
  authType: "api_key" | "oauth" | "bearer";
  authEnvVar: string;
}): Promise<{ toolPath: string; securityReport: SecurityAnalysisResult }> {

  // 1. BuilderAgent generates the tool code (balanced tier)
  const generatedCode = await builderAgent.generateToolCode(request);

  // 2. Write to temp location (NOT tools/custom yet)
  const tempPath = path.join(os.tmpdir(), `clawlite-tool-${request.name}.tool.ts`);
  fs.writeFileSync(tempPath, generatedCode);

  // 3. Run security analysis
  const securityReport = await analyzeToolSecurity(tempPath);

  // 4. If critical issues found in our own generated code, log error and abort
  if (!securityReport.passed) {
    logger.error(`BuilderAgent generated unsafe code for ${request.name}`, securityReport.criticalIssues);
    fs.unlinkSync(tempPath);
    throw new Error(`Generated tool failed security analysis: ${securityReport.criticalIssues.map(i => i.code).join(", ")}`);
  }

  return { toolPath: tempPath, securityReport };
}
```

**Critical safety rule:** Even though the Operator generated the tool, it still goes through the full security analysis. The Operator does not trust its own output. The user must approve.

### 10a.2 Template authoring

Templates are stored as YAML files in `.clawlite/templates/`. The Operator can create new templates, and users can also edit them directly.

```yaml
# .clawlite/templates/analyze_performance.yaml
id: analyze_performance
name: "Analyze Ad Performance"
description: "Pull campaign metrics from Meta Ads and generate a performance report"
subAgent: marketing
slashCommand: /adreport
slots:
  - name: dateRange
    description: "Time period to analyze"
    required: false
    default: "last_7_days"
  - name: campaignId
    description: "Specific campaign to analyze (optional, default all)"
    required: false

nodes:
  - id: fetch_campaigns
    type: meta-ads.get_campaigns
    title: "Fetch active campaigns"
    agent: WorkspaceAgent
    model: fast
    dependencies: []
    requiresApproval: false
    input:
      dateRange: "{{slots.dateRange}}"

  - id: fetch_metrics
    type: meta-ads.get_metrics
    title: "Pull performance metrics"
    agent: WorkspaceAgent
    model: fast
    dependencies: [fetch_campaigns]
    requiresApproval: false

  - id: analyze
    type: llm.analyze
    title: "Analyze performance and identify issues"
    agent: ResearchAgent
    model: balanced
    dependencies: [fetch_metrics]
    requiresApproval: false
    input:
      prompt: "Analyze these ad metrics. Identify underperforming campaigns (ROAS < {{slots.roasThreshold}}). Recommend specific actions."

  - id: report
    type: aggregate
    title: "Generate performance report"
    agent: AggregatorAgent
    model: fast
    dependencies: [analyze]
    requiresApproval: false
```

**Template validation rules:**
- All node IDs must be unique
- All dependency references must be valid
- Graph must be acyclic (DAG)
- All agent names must be registered workers
- All model tiers must be valid (fast/balanced/strong)
- All tool types must be installed tools
- Approval gates must be set on dangerous actions
- Total nodes must not exceed `hardLimits.maxNodesPerJob`

```typescript
async function createTemplate(yaml: string): Promise<{ valid: boolean; errors?: string[] }> {
  const template = parseYAML(yaml);
  const errors = validateTemplate(template);

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Save to templates directory
  const filename = `${template.id}.yaml`;
  fs.writeFileSync(path.join(".clawlite/templates", filename), yaml);

  // Register in template library
  templates.register(template);

  return { valid: true };
}
```

**Agentic-to-template promotion:** When the bounded agentic fallback generates a plan that works well, the Operator can save it as a reusable template:

```text
Operator: That worked well. Want me to save this as a reusable workflow 
          so you can run it again with /adreport?
User: Yes
Operator: ✅ Saved as template "analyze_performance" — use /adreport anytime.
```

### 10a.3 Sub-agent creation

The Operator creates sub-agents by assembling a profile from tools, templates, a persona, and a schedule:

```typescript
async function createSubAgent(request: {
  name: string;
  description: string;
  persona: string;
  tools: string[];
  templates: string[];
  budgetTokensDaily: number;
  cronJobs?: CronDefinition[];
  heartbeatConditions?: string[];
}): Promise<SubAgent> {

  // Validate all referenced tools exist
  for (const tool of request.tools) {
    if (!toolRegistry.get(tool)) {
      throw new Error(`Tool not found: ${tool}. Generate it first.`);
    }
  }

  // Validate all referenced templates exist
  for (const templateId of request.templates) {
    if (!templates.get(templateId)) {
      throw new Error(`Template not found: ${templateId}. Create it first.`);
    }
  }

  // Persist to database
  const subAgent = await db.createSubAgent(request);

  // Register cron jobs
  if (request.cronJobs) {
    for (const cron of request.cronJobs) {
      scheduler.register(cron, subAgent.id);
    }
  }

  // Register heartbeat conditions
  if (request.heartbeatConditions) {
    await db.addHeartbeatConditions(subAgent.id, request.heartbeatConditions);
  }

  logger.info(`Sub-agent created: ${subAgent.name} (${subAgent.id})`);
  return subAgent;
}
```

### 10a.4 Message routing with sub-agents

When a message comes in, the Operator decides which sub-agent should handle it:

```typescript
async function routeToSubAgent(message: string): Promise<SubAgent | null> {
  const subAgents = db.getActiveSubAgents();
  if (subAgents.length === 0) return null;

  // Fast-tier classification: which sub-agent (if any) should handle this?
  const result = await llm.complete({
    model: "fast",
    messages: [{
      role: "system",
      content: `You are a message router. Given the user's message, determine which sub-agent should handle it, or "operator" if it's a general request or a request to build something new.`
    }, {
      role: "user",
      content: `Message: "${message}"\n\nAvailable sub-agents:\n${subAgents.map(a => `- ${a.id}: ${a.description}`).join("\n")}\n\nRespond with JSON: { "target": "sub-agent-id" | "operator", "confidence": 0.0-1.0 }`
    }],
    format: "json"
  });

  if (result.parsed.target === "operator" || result.parsed.confidence < 0.7) {
    return null;  // Operator handles it directly
  }

  return subAgents.find(a => a.id === result.parsed.target) ?? null;
}
```

### 10a.5 Managing sub-agents through conversation

Users can manage their sub-agents naturally:

```text
User: Pause the marketing agent for this week
Operator: ✅ Marketing Team paused. It won't run scheduled jobs or heartbeat 
          checks until you resume it.

User: What agents do I have running?
Operator: You have 4 active sub-agents:
  🟢 inbox — Gmail management (12,000 tokens today)
  🟢 content — Daily tweet generation (8,000 tokens today)
  🟡 marketing — PAUSED
  🟢 support — Customer email triage (3,000 tokens today)
  
  Total: 23,000 / 200,000 tokens today

User: The marketing agent should also track Instagram ads, not just Facebook
Operator: I'll update the Meta Ads tool to include Instagram. The API is the 
          same (Meta Marketing API covers both). Let me update the tool...
  ⚙️ Updating meta-ads tool...
  🔒 Security analysis: 8/10 (same as before)
  ✅ Updated. The marketing agent can now see Instagram campaigns too.

User: Delete the support agent, I don't need it anymore
Operator: ⚠️ This will remove:
  - Sub-agent: Support Agent
  - 2 custom templates (triage_email, escalate_refund)
  - Cron job: hourly email check
  The tools it used (gmail, crm) will remain available for other agents.
  
  Confirm? [y/n]
User: y
Operator: ✅ Support Agent removed.
```

### 10a.6 In-chat commands for sub-agent management

| Command | Description |
|---------|-------------|
| `/agents` | List all sub-agents with status and today's token usage |
| `/agent <name>` | Show sub-agent detail (tools, templates, schedule, budget) |
| `/agent <name> pause` | Pause a sub-agent |
| `/agent <name> resume` | Resume a paused sub-agent |
| `/agent <name> delete` | Delete a sub-agent (with confirmation) |
| `/build` | Start a guided conversation to build a new sub-agent |

### 10a.7 CLI commands for sub-agent management

| Command | Description |
|---------|-------------|
| `clawlite agents` | List all sub-agents |
| `clawlite agent <name>` | Show sub-agent detail |
| `clawlite agent <name> pause` | Pause a sub-agent |
| `clawlite agent <name> resume` | Resume a sub-agent |
| `clawlite agent <name> delete` | Delete a sub-agent |
| `clawlite agent <name> logs` | Show recent jobs for this sub-agent |
| `clawlite agent <name> budget` | Show this sub-agent's token usage |

### 10a.8 Safety guarantees for self-building

The Operator can build powerful things, but every step is gated:

1. **Tool generation always runs security analysis.** Even the Operator's own generated code is scanned. Critical issues block installation.
2. **User approves every installation.** No tool is installed without the user seeing the security report and typing `y`.
3. **Templates are validated before saving.** Invalid DAGs, unknown tools, missing approval gates — all caught before the template can run.
4. **Sub-agents inherit global limits.** Circuit breakers, daily budgets, approval gates, and ledger logging apply to every sub-agent.
5. **The Operator cannot escalate its own permissions.** It can only assign tools and permissions that already exist in the system.
6. **All building actions are logged in the ledger.** Full audit trail of what was created, when, and what the user approved.
7. **Dry run works for everything.** `clawlite dryrun` and the `/dryrun` command test the full pipeline — including generated tools in mock mode.

---

## 11. TOOL SYSTEM

Tools provide capabilities to agents.

**Tool interface:**
```typescript
Tool {
  name: string
  description: string
  permissions: string[]
  schema: object
  handler(params): Promise<any>
}
```

Tools live in `/tools` and must register automatically at runtime. A file watcher on `tools/custom/` hot-loads new tools without restart (validation required: schema must parse, permissions must be declared, handler must be a function).

**MVP tools:**

| Tool | Type | Config toggle? |
|------|------|---------------|
| `workspace` | External service (gws CLI) | Yes — `config.tools.workspace` |
| `research` | External service (Perplexity API) | Yes — `config.tools.research` |
| `fs` | Internal utility (sandboxed file I/O) | No — always enabled |

The `fs` tool is internal infrastructure. It does not appear in `config.json` tool toggles because it has no external dependency and is required for artifact storage. See `TOOL_SDK.md` Section 11.3.

---

## 12. GOOGLE WORKSPACE TOOL

ClawLite integrates Google Workspace CLI (`gws`) — Google's official open-source CLI released March 2025, written in Rust, distributed via npm. It dynamically builds its command surface from Google's Discovery Service at runtime, meaning new Workspace API endpoints are supported automatically without updates.

**Two invocation modes:**

| Mode | When to use |
|------|-------------|
| `child_process.spawn` | Single commands (list emails, create event) |
| `gws mcp` MCP server | Session-based workflows, or exposing tools to MCP clients like Claude Desktop |

**Gmail:**
```
gmail.list
gmail.get
gmail.draft
gmail.send
```

**Calendar:**
```
calendar.list
calendar.create
calendar.update
calendar.delete
```

**Drive:**
```
drive.list
drive.upload
drive.download
drive.share
```

**Tool interface:**
```typescript
workspace.run(action, params)
```

**Example:**
```typescript
workspace.run("gmail.list", { query: "is:unread" })
```

The handler internally executes `gws gmail messages list` and parses CLI output into JSON.

---

## 13. RESEARCH TOOL

Perplexity API integration.

**Functions:**
```typescript
research.search(query)
research.deep(query)
```

**Deep research returns:**
```
summary
sources
key_claims
citations
```

Results are stored as artifacts.

---

## 14. BROWSER TOOL (v2 — NOT IN MVP)

Browser automation via Playwright. Deferred to v2 due to complexity.

**Capabilities:**
```
navigate
extract_text
fill_form
click
screenshot
```

**Interface:**
```typescript
browser.run({
  task: string,
  allowed_domains: string[]
})
```

Domain allowlist is required for all browser operations.

---

## 15. MEMORY SYSTEM

Memory is stored in SQLite with FTS5 full-text search. Memory is a powerful feature but also a quiet source of prompt bloat if not disciplined. This section defines not just retrieval, but **what enters memory, how large it can grow, and when it gets pruned.**

### Memory types

| Type | What gets stored | Example |
|------|--------------------|---------|
| `episodic` | Key outcomes of completed jobs | "Sent 3 emails, scheduled 1 meeting on 2025-03-05" |
| `semantic` | Durable facts about the user, contacts, preferences | "User prefers morning meetings. Client X's email is x@co.com" |
| `procedural` | Learned patterns or corrections from revisions | "User always wants email drafts to start with first name, not 'Dear'" |

### Memory structure

```typescript
Memory {
  id: string
  type: "episodic" | "semantic" | "procedural"
  content: string
  tags: string[]
  token_count: number   // estimated tokens of content field
  created_at: number
  expires_at: number | null  // null = permanent, set for episodic
}
```

### Memory ingestion rules (what is allowed to enter)

Not everything should become a memory. Unrestricted ingestion turns memory into a dumping ground that quietly inflates every prompt.

**Allowed:**
- Job completion summaries (episodic) — auto-generated by executor, max 200 tokens
- User corrections during revision flows (procedural) — extracted from revision instructions
- Explicit user-provided facts ("remember that X") (semantic) — stored as-is
- Session compaction summaries (episodic) — generated when sessions are compacted

**Not allowed:**
- Raw API responses (email bodies, full research reports) — these are artifacts, not memories
- Intermediate node outputs — these live in the artifact table
- Duplicate facts — before storing, check if a semantically similar memory already exists (FTS5 match score > threshold)

**Ingestion function:**
```typescript
async function ingestMemory(params: {
  type: Memory["type"];
  content: string;
  tags: string[];
  ttlDays?: number;  // default: 30 for episodic, null for semantic/procedural
}): Promise<{ stored: boolean; reason?: string }> {
  // 1. Size gate: reject if content > 300 tokens
  const tokens = estimateTokens(params.content);
  if (tokens > 300) {
    return { stored: false, reason: "content_too_long" };
  }

  // 2. Duplicate gate: check FTS5 for similar existing memory
  const similar = await memory.retrieve(params.content, 1);
  if (similar.length > 0 && similar[0].score > 0.85) {
    return { stored: false, reason: "duplicate" };
  }

  // 3. Store with expiry
  const expiresAt = params.ttlDays
    ? Date.now() + params.ttlDays * 24 * 60 * 60 * 1000
    : null;

  await db.insertMemory({
    type: params.type,
    content: params.content,
    tags: params.tags,
    token_count: tokens,
    expires_at: expiresAt
  });

  return { stored: true };
}
```

### FTS5 table

```sql
CREATE VIRTUAL TABLE memory_fts USING fts5(content, tags, content=memory, content_rowid=rowid);
```

### Retrieval (tag match first, FTS5 second)

```typescript
memory.retrieve(query: string, limit: number)
```

1. First: exact tag match
2. Second: FTS5 full-text search with rank scoring
3. Return max 3 items per node prompt (not 5 — tighter context = fewer tokens)
4. Total injected memory must not exceed 500 tokens. If 3 items exceed this, truncate to 2 or 1.

### Memory pruning (prevents unbounded growth)

Pruning runs once daily (on first job of the day, or on startup).

```typescript
async function pruneMemory() {
  // 1. Delete expired episodic memories
  db.deleteExpiredMemories(Date.now());

  // 2. Enforce hard cap: max 500 memory items total
  const count = db.countMemories();
  if (count > 500) {
    // Delete oldest episodic memories first
    db.deleteOldestMemories("episodic", count - 500);
  }

  // 3. Log pruning stats
  ledger.log({ action: "memory_prune", result: { before: count, after: db.countMemories() } });
}
```

**Memory limits:**

| Limit | Value | Rationale |
|-------|-------|-----------|
| Max content per item | 300 tokens | Prevents prompt bloat |
| Max items retrieved per node | 3 | Tighter context = fewer tokens |
| Max total injected tokens per node | 500 | Hard ceiling on memory's prompt footprint |
| Max total items in DB | 500 | Prevents unbounded growth |
| Episodic TTL | 30 days default | Old job summaries lose relevance |
| Semantic/procedural TTL | None (permanent) | User facts and learned patterns persist |

**Why not embeddings for MVP:** FTS5 is built into better-sqlite3, requires zero dependencies, and gets 80% of the value. Embeddings can be added in v2 when retrieval quality needs to improve.

---

## 15a. SESSION SYSTEM (NEW — conversational continuity)

ClawLite maintains a lightweight session per chat that provides conversational context. This makes the chat path feel like a persistent assistant rather than a stateless command executor.

### What sessions provide

- Recent conversation history injected into chat-path prompts (last 3-5 turns)
- Answers to "what did you just do?" and "can you change that?"
- Context for follow-up questions without restating everything
- Automatic compaction when sessions grow too large

### Session storage

```sql
CREATE TABLE sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     TEXT NOT NULL,           -- channel-specific chat identifier
  channel     TEXT NOT NULL,           -- "telegram", "whatsapp", etc.
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_sessions_chat ON sessions(chat_id, channel, created_at DESC);
```

### Session injection into chat path

```typescript
function getSessionContext(chatId: string, channel: string): Message[] {
  const turns = db.getRecentSessions(
    chatId, channel, config.session.turnsInjectedIntoChat  // default 5
  );
  return turns.map(t => ({ role: t.role, content: t.content }));
}
```

### Session compaction

When a chat's total session tokens exceed `config.session.compactionThresholdTokens` (default 8000):

1. Summarize older turns using a `fast` tier call
2. Store the summary as an episodic memory
3. Delete the compacted turns from the sessions table
4. Keep the most recent `turnsInjectedIntoChat` turns intact

```typescript
async function compactSession(chatId: string, channel: string) {
  const allTurns = db.getAllSessionTurns(chatId, channel);
  const totalTokens = allTurns.reduce((sum, t) => sum + t.token_count, 0);

  if (totalTokens < config.session.compactionThresholdTokens) return;

  // Keep recent turns, compact the rest
  const keepCount = config.session.turnsInjectedIntoChat;
  const toCompact = allTurns.slice(0, -keepCount);

  if (toCompact.length === 0) return;

  const summary = await llm.complete({
    model: "fast",
    messages: [{
      role: "system",
      content: "Summarize this conversation into key facts and decisions. Max 200 tokens. JSON not needed — just concise text."
    }, {
      role: "user",
      content: toCompact.map(t => `${t.role}: ${t.content}`).join("\n")
    }]
  });

  recordTokenUsage(summary.usage.total_tokens);

  // Store as episodic memory
  await ingestMemory({
    type: "episodic",
    content: summary.text,
    tags: ["session_compaction", chatId],
    ttlDays: 30
  });

  // Delete compacted turns
  db.deleteSessionTurns(chatId, channel, toCompact.map(t => t.id));
}
```

### Session is NOT job state

Sessions provide **conversational context** only. Job state, node outputs, and artifacts live in the jobs/nodes/artifacts tables. The session system is purely for the chat path — it makes "hey what's up" and follow-up questions work better. Workers don't read sessions; they read upstream artifacts and memory.

---

## 15b. SECRETS MANAGEMENT (NEW)

API keys, tokens, and credentials are stored in `.clawlite/.env` — never in `config.json` (which may be committed to version control). Secrets are collected during onboarding, during sub-agent creation, or whenever the agent needs a new API connection.

### .env file format

```bash
# .clawlite/.env — auto-managed by ClawLite, editable by user
# ⚠️ Never commit this file to version control

# LLM Provider
OPENROUTER_API_KEY=sk-or-v1-abc123...

# Research
PERPLEXITY_API_KEY=pplx-abc123...

# Google Workspace
GWS_CREDENTIALS_PATH=/Users/paul/.config/gws/credentials.json

# Telegram
TELEGRAM_BOT_TOKEN=7891234:AAH_xYz...

# Added by sub-agents:
META_ADS_TOKEN=EAAGz...
OPENAI_API_KEY=sk-abc123...
TWITTER_API_KEY=...
TWITTER_API_SECRET=...
TWITTER_BEARER_TOKEN=...
VERCEL_TOKEN=...
STRIPE_SECRET_KEY=sk_live_...
GITHUB_TOKEN=ghp_...
```

### Loading secrets

Secrets are loaded at startup and available via `ctx.secrets.get()` in tools:

```typescript
import * as dotenv from "dotenv";

function loadSecrets(): Map<string, string> {
  const envPath = path.join(getClawliteHome(), ".env");
  if (!fs.existsSync(envPath)) return new Map();

  const parsed = dotenv.parse(fs.readFileSync(envPath));
  return new Map(Object.entries(parsed));
}

// In tool context:
const token = ctx.secrets.get("META_ADS_TOKEN");
```

### In-chat key collection

When the Operator builds a new sub-agent or tool that needs API keys, it asks the user directly in chat:

```typescript
async function requestSecret(
  adapter: ChannelAdapter,
  chatId: string,
  keyName: string,
  description: string,
  helpUrl?: string
): Promise<string> {
  let message = `🔑 I need your ${description} to set this up.\n`;
  if (helpUrl) {
    message += `You can get one here: ${helpUrl}\n`;
  }
  message += `\nPaste the key here and I'll store it securely.`;

  await adapter.sendMessage(chatId, { text: message, parseMode: "plain" });

  // Wait for the next message from this chat
  const response = await waitForUserMessage(chatId, adapter, 300000); // 5 min timeout

  const key = response.text.trim();

  // Store in .env
  appendToEnvFile(keyName, key);

  // Warn user to delete the message
  await adapter.sendMessage(chatId, {
    text: `✅ ${keyName} saved securely to .clawlite/.env\n\n⚠️ For security, delete your previous message containing the key from this chat.`,
    parseMode: "plain"
  });

  return key;
}

function appendToEnvFile(key: string, value: string) {
  const envPath = path.join(getClawliteHome(), ".env");
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";

  // Update if key exists, append if new
  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(existing)) {
    const updated = existing.replace(regex, `${key}=${value}`);
    fs.writeFileSync(envPath, updated);
  } else {
    fs.appendFileSync(envPath, `\n${key}=${value}\n`);
  }

  // Hot-reload secrets
  secrets.set(key, value);
}
```

### Key collection during sub-agent creation

When the Operator builds a tool that declares required secrets (see TOOL_SDK.md Section 14a), it checks which keys are missing and collects them:

```text
Harri: I need a few API keys to set up your marketing agent:

  🔑 META_ADS_TOKEN — Your Meta Business access token
     Get one at: https://developers.facebook.com/tools/accesstoken
     Paste it here:

Paul: EAAGz...

Harri: ✅ META_ADS_TOKEN saved.
  ⚠️ Delete your previous message for security.

  🔑 OPENAI_API_KEY — For generating ad images via DALL-E
     You already have this configured. ✓

  All keys ready. Continuing build...
```

### Security rules for secrets

1. **Never log secret values.** Ledger entries, logs, and error messages must redact secrets.
2. **Never include secrets in LLM prompts.** Tools access secrets via `ctx.secrets.get()`, not via prompt injection.
3. **Never store secrets in config.json.** Config may be shared or committed; .env must not be.
4. **Warn the user to delete key messages.** After receiving a key in chat, always remind the user.
5. **.env is user-readable.** The user can always inspect, edit, or remove keys manually.
6. **.gitignore .env by default.** If the user initializes a git repo in `.clawlite/`, the `.env` file must be in `.gitignore`.

---

## 15c. FILE UPLOADS (NEW)

Users can send files through any messaging channel. The agent receives them, stores them as artifacts, and makes them available to workers for use in workflows — attaching to emails, processing documents, analyzing images, etc.

### How file uploads work

1. User sends a file (PDF, image, document) through their channel
2. The channel adapter downloads the file and extracts metadata
3. The file is stored in `.clawlite/artifacts/uploads/` with a unique ID
4. The Operator acknowledges receipt and asks what to do with it (or infers from context)
5. The file is available to workers via `ctx.artifacts` for the current and future jobs

### Channel adapter file handling

```typescript
// Updated InboundMessage — already has attachments field
interface Attachment {
  type: "image" | "audio" | "video" | "document";
  url?: string;          // platform-specific download URL
  buffer?: Buffer;       // file content (if already downloaded)
  mimeType: string;
  filename?: string;
  fileSize?: number;
}
```

Each channel adapter handles downloads differently:

| Channel | How files arrive | Download method |
|---------|-----------------|-----------------|
| Telegram | `file_id` reference | `bot.getFile(file_id)` → download URL |
| WhatsApp | Media URL in message | `axios.get(mediaUrl, { headers: { auth } })` |
| Discord | Attachment URL | Direct HTTP download |
| Slack | File object with URL | `app.client.files.info()` → download URL |
| WebChat | File upload via browser | Multipart form upload to Fastify endpoint |

### File processing flow

```typescript
async function handleFileUpload(
  msg: InboundMessage,
  adapter: ChannelAdapter
): Promise<void> {
  if (!msg.attachments || msg.attachments.length === 0) return;

  for (const attachment of msg.attachments) {
    // 1. Download the file
    const buffer = attachment.buffer ?? await downloadFile(attachment.url!, adapter.name);

    // 2. Store as artifact
    const artifact = await db.storeFileArtifact({
      type: `upload_${attachment.type}`,
      title: attachment.filename ?? `upload_${Date.now()}`,
      path: saveToUploadsDir(buffer, attachment.filename, attachment.mimeType),
      mimeType: attachment.mimeType,
      fileSize: buffer.length,
      metadata: {
        channel: msg.channelName,
        chatId: msg.chatId,
        uploadedAt: Date.now()
      }
    });

    // 3. Store reference in session for context
    db.insertSession({
      chatId: msg.chatId,
      channel: msg.channelName,
      role: "user",
      content: `[Uploaded file: ${attachment.filename ?? 'file'} (${attachment.mimeType}, ${formatBytes(buffer.length)})] artifact:${artifact.id}`,
      tokenCount: 20
    });
  }

  // 4. If user also sent text, process as normal message with file context
  // If no text, acknowledge and ask what to do
  if (!msg.text?.trim()) {
    const fileNames = msg.attachments.map(a => a.filename ?? a.type).join(", ");
    await adapter.sendMessage(msg.chatId, {
      text: `📎 Received: ${fileNames}\nWhat would you like me to do with ${msg.attachments.length > 1 ? 'these files' : 'this file'}?`,
      parseMode: "plain"
    });
  }
}
```

### Using uploaded files in workflows

Workers can reference uploaded files via artifact IDs:

```text
Paul: [sends W-9.pdf]
Paul: Send this W-9 to onboarding@brandedgroup.com

  [Router: complex → the session contains the uploaded file reference]

Harri: 🚀 Job started
  1. ⚙️ Drafting email with W-9 attachment...
  2. 📧 Approval Required
     Action: Send email to onboarding@brandedgroup.com
     Subject: W-9 Form — 305 Locksmith LLC
     Body: Hi Sarah, please find our W-9 attached...
     📎 Attachment: W-9.pdf (142 KB)

     [✅ Approve] [❌ Reject] [✏️ Revise]
```

The WorkspaceAgent accesses the file via the artifact system:

```typescript
// Inside WorkspaceAgent, when sending an email with attachment
const uploadArtifact = await db.getArtifact(node.input.attachmentArtifactId);
const filePath = uploadArtifact.path;  // .clawlite/artifacts/uploads/W-9.pdf

await invokeTool("workspace", {
  action: "gmail.send",
  params: {
    to: node.input.to,
    subject: node.input.subject,
    body: node.input.body,
    attachments: [{ path: filePath, filename: uploadArtifact.title }]
  }
}, ctx);
```

### WebChat file upload endpoint

The WebChat adapter serves a file upload endpoint on the Fastify server:

```typescript
fastify.post('/upload', async (req, reply) => {
  const data = await req.file();  // @fastify/multipart
  const buffer = await data.toBuffer();

  // Process as attachment
  const attachment: Attachment = {
    type: inferType(data.mimetype),
    buffer,
    mimeType: data.mimetype,
    filename: data.filename,
    fileSize: buffer.length
  };

  // Store and notify via WebSocket
  // ...
});
```

### Supported file types

| Type | Extensions | Max size | Use cases |
|------|-----------|----------|-----------|
| Document | .pdf, .docx, .xlsx, .csv, .txt | 25 MB | Email attachments, invoice data, reports |
| Image | .jpg, .png, .gif, .webp | 10 MB | Ad creatives, profile photos, screenshots |
| Audio | .mp3, .wav, .ogg | 25 MB | Voice memos (v2: transcription) |
| Video | .mp4, .mov | 50 MB | v2: video processing |

---

## 16. ACTION LEDGER

Every tool call is logged.

**Ledger schema:**
```typescript
LedgerEntry {
  id: string
  agent: string
  action: string
  tool: string
  params: object
  result: object
  status: string
  timestamp: number
  cost_tokens: number
}
```

**Purpose:**
- Debugging
- Transparency
- Auditing
- Observability dashboard (via HTTP status API)

---

## 17. SECURITY SYSTEM

### Hard Circuit Breakers (prevents OpenClaw-style runaway)

Every job is subject to hard limits that cannot be overridden. If any limit is exceeded, the job dies immediately and the user is notified.

```typescript
const HARD_LIMITS = {
  maxNodesPerJob: 20,
  maxTotalLLMCalls: 30,
  maxJobDurationMs: 5 * 60 * 1000,  // 5 minutes
  maxRetriesTotalPerJob: 10,
  // Agentic fallback limits
  agenticMaxIterations: 5,
  agenticMaxNodes: 10,
  agenticMaxTokenBudget: 30000
};
```

These are read from `config.json` under `hardLimits` and enforced by the executor at every node dispatch and every LLM call.

### Budget Limits

ClawLite enforces budgets at two levels: **per-job** and **daily**.

**Per-job budget** — each job includes:
```
token_budget
time_budget
tool_call_limit
```
Execution halts when any per-job budget is exceeded.

**Daily budget** — a system-wide rolling token ceiling that prevents total spend from exceeding `config.budgets.dailyTokens` in any 24-hour window.

**Daily budget enforcement rules:**

```typescript
interface DailyBudgetState {
  windowStart: number;    // epoch ms — start of current 24h window
  tokensConsumed: number; // total tokens used in current window
}
```

1. **Check before every job starts.** If `tokensConsumed >= dailyTokens`, reject the job and notify the user: "Daily token budget exhausted. Resets at [time]."
2. **Check before every node dispatch.** If the remaining daily budget is less than the node's `tokenBudget`, cancel the node and fail the job with reason `daily_budget_exhausted`.
3. **Decrement after every node completes.** Add `result.costTokens` to `tokensConsumed` in a single SQLite transaction alongside the node status update.
4. **Reset on window expiry.** When `Date.now() - windowStart > 24 * 60 * 60 * 1000`, reset `tokensConsumed = 0` and `windowStart = Date.now()`. This check runs on every job start.
5. **Chat path counts too.** Lightweight chat responses must check `checkDailyBudget()` before calling the LLM and call `recordTokenUsage()` after. No path is exempt.
6. **Heartbeat counts too.** Heartbeat LLM calls are subject to the same daily budget.
7. **Persist in SQLite.** `daily_budget` is a single-row table, not in-memory. This survives restarts.

```sql
CREATE TABLE daily_budget (
  id          INTEGER PRIMARY KEY CHECK (id = 1),  -- single row
  window_start INTEGER NOT NULL,
  tokens_consumed INTEGER NOT NULL DEFAULT 0
);
```

```typescript
function checkDailyBudget(requiredTokens: number): { ok: boolean; remaining: number } {
  const budget = db.getDailyBudget();
  const now = Date.now();

  // Reset if window expired
  if (now - budget.windowStart > 24 * 60 * 60 * 1000) {
    db.resetDailyBudget(now);
    return { ok: true, remaining: config.budgets.dailyTokens };
  }

  const remaining = config.budgets.dailyTokens - budget.tokensConsumed;
  return { ok: remaining >= requiredTokens, remaining };
}

function recordTokenUsage(tokens: number) {
  db.transaction(() => {
    db.incrementDailyTokens(tokens);
  })();
}
```

### Tool Permissions

Each agent has scoped tool access. Example:

```
WorkspaceAgent:
  gmail.read       ✓ allowed
  gmail.draft      ✓ allowed
  gmail.send       ⚠ requires approval
```

### Approval Gates

Required for:
```
send_email
create_calendar_event
deploy_production
share_drive_file
post_social_media
delete_data
```

Approvals are stored in the database and presented via the user's chosen channel's inline buttons or reaction system.

### Webhook Authentication

All incoming webhook requests must include `?token=SECRET` matching `config.http.webhookToken`. Invalid tokens receive 401 immediately.

---

## 18. DRY RUN MODE

ClawLite supports a `dryRun` flag on any job. When enabled:
- All tool calls are logged but not executed
- Tools return mock/preview responses
- The full planning → execution → approval flow runs end-to-end
- No external side effects occur

```typescript
interface Job {
  // ... existing fields
  dryRun: boolean;
}
```

**Usage via any channel:**
```
/dryrun Check my inbox and draft replies
```

This lets you test the entire system without touching Gmail, Calendar, or any external service. Essential for development and debugging.

---

## 19. DATABASE SCHEMA

SQLite schema.

**jobs**
```sql
id           TEXT PRIMARY KEY
goal         TEXT
status       TEXT
trigger_type TEXT
channel      TEXT
chat_id      TEXT
dry_run      INTEGER DEFAULT 0
job_type     TEXT DEFAULT 'template'
sub_agent_id TEXT            -- NEW: which sub-agent owns this job (null = operator)
created_at   INTEGER
budget_tokens INTEGER
```

**sub_agents (NEW — dynamic sub-agent profiles)**
```sql
id              TEXT PRIMARY KEY
name            TEXT NOT NULL
description     TEXT
persona         TEXT NOT NULL
tools           TEXT NOT NULL          -- JSON array of tool names
templates       TEXT NOT NULL          -- JSON array of template IDs
default_tier    TEXT NOT NULL DEFAULT 'fast'
budget_daily    INTEGER NOT NULL DEFAULT 50000
cron_jobs       TEXT                   -- JSON array of CronDefinitions
heartbeat_conds TEXT                   -- JSON array of condition strings
status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled'))
created_by      TEXT NOT NULL DEFAULT 'operator'
created_at      INTEGER NOT NULL
updated_at      INTEGER NOT NULL
```

**nodes**
```sql
id           TEXT PRIMARY KEY
job_id       TEXT
type         TEXT
status       TEXT
dependencies TEXT  -- JSON array
agent        TEXT
model        TEXT
input_data   TEXT  -- JSON
output_data  TEXT  -- JSON
```

**runs**
```sql
id           TEXT PRIMARY KEY
node_id      TEXT
start_time   INTEGER
end_time     INTEGER
cost_tokens  INTEGER
status       TEXT
```

**ledger**
```sql
id        TEXT PRIMARY KEY
agent     TEXT
tool      TEXT
action    TEXT
params    TEXT  -- JSON
result    TEXT  -- JSON
timestamp INTEGER
cost      INTEGER
```

**memory**
```sql
id          TEXT PRIMARY KEY
type        TEXT NOT NULL CHECK (type IN ('episodic', 'semantic', 'procedural'))
content     TEXT NOT NULL
tags        TEXT           -- JSON array
token_count INTEGER NOT NULL DEFAULT 0
created_at  INTEGER NOT NULL
expires_at  INTEGER        -- NULL = permanent
```

**memory_fts (FTS5 virtual table)**
```sql
CREATE VIRTUAL TABLE memory_fts USING fts5(content, tags, content=memory, content_rowid=rowid);
```

**daily_budget (single-row rolling window)**
```sql
CREATE TABLE daily_budget (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  window_start    INTEGER NOT NULL,
  tokens_consumed INTEGER NOT NULL DEFAULT 0
);
```

**sessions (NEW — conversational continuity)**
```sql
CREATE TABLE sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     TEXT NOT NULL,
  channel     TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_sessions_chat ON sessions(chat_id, channel, created_at DESC);
```

---

## 20. CHANNEL INTERFACE (UPDATED — multi-channel)

ClawLite supports multiple messaging channels through a unified adapter layer. Users select one or more channels during onboarding. All channels share the same router, executor, and approval system.

See `CHANNEL_ADAPTERS.md` for the full channel abstraction specification.

**Supported channels (MVP):**

| Channel | Library | Auth Method |
|---------|---------|------------|
| Telegram | `node-telegram-bot-api` | Bot token + user ID allowlist |
| WhatsApp | `@whiskeysockets/baileys` | QR code pairing |
| Discord | `discord.js` | Bot token + user ID allowlist |
| Slack | `@slack/bolt` | Bot token + app token |
| WebChat | Built-in (Fastify + WebSocket) | Auth token (auto-generated) |

**In-chat commands (all channels):**

All system management available through conversation — no terminal needed. Users can also phrase these as natural language ("show my agents", "how's the budget", "pause the content agent") and the router will interpret them.

*Workflow commands:*

| Command | Description |
|---------|-------------|
| `/inbox` | List unread emails |
| `/draft` | Draft a new email |
| `/send` | Send a drafted email |
| `/today` | Today's calendar events |
| `/schedule` | Create a calendar event |
| `/research <topic>` | Run a research query |
| `/dryrun <goal>` | Execute a job in dry run mode |
| `/cancel <jobId>` | Cancel a running job |

*System commands (same data as CLI equivalents):*

| Command | Description |
|---------|-------------|
| `/status` | System overview — uptime, channels, budget, active jobs, heartbeat |
| `/budget` | Daily token usage with per-agent breakdown |
| `/jobs` | List recent jobs with status |
| `/job <id>` | Show job detail — nodes, cost, duration |
| `/tools` | List all installed tools with status and security score |
| `/templates` | List all templates (built-in + generated) |
| `/help` | List all available commands |

*Sub-agent commands:*

| Command | Description |
|---------|-------------|
| `/agents` | List all sub-agents with status and today's token usage |
| `/agent <name>` | Show sub-agent detail — tools, templates, schedule, budget |
| `/agent <name> pause` | Pause a sub-agent (stops scheduled jobs and heartbeat) |
| `/agent <name> resume` | Resume a paused sub-agent |
| `/agent <name> delete` | Delete a sub-agent (with confirmation) |
| `/build` | Start a guided conversation to build a new sub-agent |

*Profile & memory commands:*

| Command | Description |
|---------|-------------|
| `/remember <fact>` | Add a fact to your profile (USER.md + semantic memory) |
| `/forget <fact>` | Remove a fact from your profile |
| `/profile` | Show your current profile |
| `/memory` | Show recent memory items |
| `/memory search <query>` | Search memory via FTS5 |

*Heartbeat commands:*

| Command | Description |
|---------|-------------|
| `/heartbeat list` | Show all active heartbeat conditions |
| `/heartbeat add <condition>` | Add a new heartbeat condition |
| `/heartbeat remove <condition>` | Remove a heartbeat condition |
| `/heartbeat now` | Trigger a heartbeat check immediately |

**Natural language equivalents:** Users don't have to memorize slash commands. The router understands natural language for all of these:

```text
"what's your status"        →  /status
"show my agents"            →  /agents
"how's the budget"          →  /budget
"pause the content agent"   →  /agent content pause
"remember that Sarah left Branded Group, Mike is my new contact"  →  /remember ...
"add a heartbeat check for overdue invoices"  →  /heartbeat add ...
"what do you know about me" →  /profile
```

**Principle: the user should never need to open a terminal or a text editor to manage ClawLite.** Everything is accessible through conversation. The terminal CLI exists for power users, scripting, and automation — it is not the primary interface.

**Message flow:**
```
User → Channel Adapter → Router → (chat | command | complex) → Response via same adapter
```

---

## 21. HTTP SERVER (NEW)

ClawLite runs a lightweight Fastify HTTP server for webhooks, artifact viewing, and system observability.

### Webhook endpoint

```
POST /hooks/:templateId?token=SECRET
Body: { "slots": { ... }, "agentProfile": "default" }
```

Triggers any template graph from external systems (n8n, Zapier, GitHub Actions, cron on another server). Same budget checks, circuit breakers, and approval gates as channel-initiated jobs.

```typescript
fastify.post('/hooks/:templateId', async (req, reply) => {
  // Auth check
  if (req.query.token !== config.http.webhookToken) {
    return reply.status(401).send({ error: "unauthorized" });
  }

  const template = templates.get(req.params.templateId);
  if (!template) {
    return reply.status(404).send({ error: "template_not_found" });
  }

  const { slots, agentProfile } = req.body;
  const notifyChannel = getDefaultNotificationChannel();

  try {
    const job = await createJobFromTemplate(template, slots ?? {}, {
      triggerType: "webhook",
      channelId: notifyChannel.id,
      chatId: notifyChannel.defaultChatId,
      dryRun: false
    });

    return reply.send({ jobId: job.id, status: "started" });
  } catch (err) {
    return reply.status(400).send({ error: err.message });
  }
});
```

### Artifact viewer

```
GET /artifacts/:id
```

Serves generated artifacts (research reports, draft documents, comparison tables) as rendered HTML. When a job produces rich output, the channel message includes a link instead of cramming everything into a message character limit.

```typescript
fastify.get('/artifacts/:id', async (req, reply) => {
  const artifact = db.getArtifact(req.params.id);
  if (!artifact) return reply.status(404).send("Not found");

  if (artifact.type === 'html') {
    return reply.type('text/html').send(artifact.content);
  }

  // Render markdown/JSON as HTML
  return reply.type('text/html').send(renderArtifactAsHTML(artifact));
});
```

### Status API

```
GET /status
```

Returns current system state as JSON — for dashboards, monitoring, and debugging.

```typescript
fastify.get('/status', async (req, reply) => {
  return reply.send({
    uptime: process.uptime(),
    operator: config.operator.name,
    channels: getActiveChannelSummary(),
    activeJobs: db.getJobsByStatus(["running", "waiting_approval"]).length,
    dailyBudget: {
      consumed: db.getDailyBudget().tokensConsumed,
      limit: config.budgets.dailyTokens,
      remaining: config.budgets.dailyTokens - db.getDailyBudget().tokensConsumed
    },
    memoryItems: db.countMemories(),
    lastHeartbeat: db.getLastHeartbeatTime(),
    recentJobs: db.getRecentJobs(5)
  });
});
```

---

## 22. CONCURRENCY MODEL

Workers execute in parallel.

```typescript
max_workers = 4  // default
```

The executor schedules graph nodes according to available worker slots and dependency resolution.

---

## 23. EXTENSIBILITY

ClawLite supports dynamic tool installation via hot-loading.

Custom tools can be added to:
```
/tools/custom
```

A file watcher detects new `*.tool.ts` files and validates them before registration. Agents automatically gain new capabilities at runtime without restart.

**Example custom tools:**
- CRM tool
- Finance tool
- SaaS builder tool
- Analytics tool

---

## 24. MVP FEATURES (Version 1)

- [x] Onboarding CLI (`clawlite setup`)
- [x] CLI daemon management (start, stop, restart, status)
- [x] CLI diagnostics (logs, jobs, budget, memory search)
- [x] CLI maintenance (reset, db backup/vacuum)
- [x] CLI direct interaction (send, dryrun, heartbeat --now)
- [x] CLI config management (get, set, show, validate)
- [x] Provider-agnostic LLM integration (OpenRouter, Anthropic, OpenAI, custom)
- [x] Three-tier model system (fast/balanced/strong)
- [x] Message router (chat/command/complex)
- [x] Multi-channel interface (Telegram, WhatsApp, Discord, Slack, WebChat)
- [x] Channel adapter abstraction layer
- [x] Template-based task graphs (built-in + user-defined YAML)
- [x] Bounded agentic fallback for unmatched requests
- [x] **Operator-as-orchestrator with dynamic sub-agent management**
- [x] **Self-building: operator generates tools, templates, and sub-agents through conversation**
- [x] **BuilderAgent for tool and template generation**
- [x] **Sub-agent creation, pause, resume, delete via chat and CLI**
- [x] **YAML template authoring (user-editable, agent-generated)**
- [x] **Agentic-to-template promotion (save working plans as reusable templates)**
- [x] Core workers (Workspace, Research, Publisher, Aggregator, Builder)
- [x] Workspace CLI integration
- [x] Research tool
- [x] **Tool installation from GitHub and MCP registry with security analysis**
- [x] **Tool generation by BuilderAgent with security analysis**
- [x] FTS5 memory system
- [x] Session system with conversational continuity
- [x] Ledger logging
- [x] Approval system
- [x] SQLite storage
- [x] Hard circuit breakers
- [x] Dry run mode
- [x] Heartbeat system (proactive condition checks)
- [x] PERSONA.md / USER.md identity files
- [x] HTTP server (webhooks, artifact viewer, status API)
- [x] Tool hot-loading

---

## 25. v2 FEATURES (After core is stable)

- [ ] Freeform DAG generation (planner LLM — extends bounded agentic)
- [ ] BrowserAgent (Playwright)
- [ ] BuilderAgent (code generation)
- [ ] ReviewerAgent (quality checks)
- [ ] Embedding-based memory retrieval
- [ ] Web dashboard (builds on status API)
- [ ] Plugin marketplace (with security vetting)
- [ ] Team mode
- [ ] Additional channel adapters (Signal, iMessage, Matrix)

---

## 26. FUTURE CAPABILITIES

- SaaS builder agents
- Customer support automation
- Financial management agents
- Social media growth agents
- Data analytics agents
- Personal productivity agents

---

## 27. DEVELOPMENT PHASES

### Phase 1 — Core Loop
```
Onboarding CLI (clawlite setup) with channel selection
CLI daemon management (start, stop, restart, status)
CLI diagnostic commands (logs, jobs, budget, memory)
CLI config commands (get, set, show, validate)
CLI maintenance commands (reset, db backup/vacuum)
LLM provider abstraction (OpenRouter, Anthropic, OpenAI, custom)
SQLite schema + DB layer (including sub_agents table)
Channel adapter interface + Telegram adapter
Message router (chat/command/complex)
Template graph engine (built-in templates + YAML loader)
Tool SDK pipeline with invokeTool()
Hard circuit breakers
Fastify HTTP server (status endpoint)
```

### Phase 2 — Channels & Tools
```
WhatsApp adapter (Baileys)
Discord adapter
Slack adapter
WebChat adapter (built-in browser UI)
Workspace tool (gws integration)
Research tool (Perplexity)
Core workers: WorkspaceAgent, ResearchAgent, PublisherAgent, AggregatorAgent
Model tiering per node
Tool installation from GitHub/MCP with security analysis
```

### Phase 3 — Self-Building & Intelligence
```
BuilderAgent (tool generation, template authoring)
Operator sub-agent routing (classify → delegate to sub-agent)
Sub-agent creation through conversation
Tool generation through conversation (with security analysis)
YAML template authoring (agent-generated + user-editable)
Agentic-to-template promotion
Sub-agent management (pause, resume, delete, budget)
Bounded agentic fallback
Session system with compaction
Heartbeat system (global + per-sub-agent conditions)
PERSONA.md / USER.md loading
```

### Phase 4 — Safety & Polish
```
Approval flow via channel inline buttons
Ledger logging
FTS5 memory
Dry run mode
Crash recovery / resumability
Webhook endpoint
Artifact viewer
Tool hot-loading
Structured JSON logging
Status API
```

### Phase 5 — Expansion (v2)
```
BrowserAgent (Playwright)
ReviewerAgent (quality checks)
Embedding-based memory retrieval
Web dashboard (builds on status API + WebChat)
Plugin marketplace (with security vetting)
Team mode (multi-user)
Sub-agent budget enforcement (hard limits per sub-agent)
Additional channel adapters (Signal, iMessage, Matrix)
```

---

## 28. ARCHITECTURAL RULES (MANDATORY)

> **Rule 1: No infinite autonomous thought loops.** ClawLite operates as: `event → route → plan graph → execute graph → sleep`. The bounded agentic fallback has hard iteration limits.

> **Rule 2: Not every message is a job.** Simple chat goes through the lightweight path with session context. Only complex requests create task graphs.

> **Rule 3: Every node has an explicit model assignment.** No defaulting to expensive models. The cheapest model that can do the job is always preferred.

> **Rule 4: Hard limits are non-negotiable.** Circuit breakers kill jobs that exceed limits. No exceptions, no overrides at runtime.

> **Rule 5: Template graphs before freeform planning.** Use existing templates when possible. Bounded agentic for edge cases. Freeform DAG generation only when no template fits.

> **Rule 6: Channel-agnostic core.** The router, executor, workers, and memory never reference a specific messaging platform. All channel-specific logic lives in adapters.

> **Rule 7: Heartbeat is not an agentic loop.** The heartbeat makes one classification call and can only trigger existing template graphs. It does not run tools directly.

> **Rule 8: The Operator builds, sub-agents execute.** The Operator creates tools, templates, and sub-agents. Sub-agents run workflows. Workers execute nodes. No layer crosses into another's responsibility.

> **Rule 9: User approves all capability changes.** Every new tool, template, and sub-agent requires explicit user approval before activation. The Operator cannot silently extend its own capabilities.

> **Rule 10: Generated code is untrusted.** Even tool code generated by the Operator's own BuilderAgent goes through the full security analysis pipeline. No exceptions.

> **Rule 11: Conversation-first.** The user should never need to open a terminal, text editor, or file browser to manage ClawLite. Everything — profile updates, heartbeat conditions, sub-agent management, status checks, memory — is accessible through chat. Files (USER.md, HEARTBEAT.md, PERSONA.md) exist as the source of truth for power users, but the primary interface is always the conversation.

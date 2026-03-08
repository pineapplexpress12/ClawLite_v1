# CLAUDE.md
## ClawLite — Build Instructions for Claude Code

---

## PROJECT OVERVIEW

ClawLite is a local-first AI operator platform built with Node.js and TypeScript. It runs as a single process with a SQLite database, connects to messaging channels (Telegram, WhatsApp, Discord, Slack, WebChat), and executes multi-step workflows as parallel DAGs with safety controls.

The user talks to an Operator Agent through their messaging app. The Operator routes messages, delegates work to specialized sub-agents, and can build new tools, templates, and sub-agents through conversation. Everything requires user approval before external actions are taken.

**Read all 5 spec files before writing any code.** They are the complete architecture:
- `CLAWSPEC.md` — system overview, runtime model, agent hierarchy, self-building, all features
- `TASKGRAPH_ENGINE.md` — template graphs, DAG executor, bounded agentic fallback
- `CHANNEL_ADAPTERS.md` — multi-channel abstraction, per-channel implementations
- `TOOL_SDK.md` — tool system, security analysis, installation, generation
- `WORKER_AGENTS.md` — worker implementations, BuilderAgent, sub-agent execution

---

## TECH STACK

- **Runtime:** Node.js ≥ 22, TypeScript strict mode
- **Database:** SQLite via `better-sqlite3` (with FTS5 enabled)
- **HTTP:** Fastify with `@fastify/websocket`, `@fastify/multipart`, `@fastify/static`
- **Validation:** Zod for all schemas
- **Config:** `dotenv` for secrets, JSON for config
- **LLM:** `openai` SDK (works for OpenRouter, OpenAI, and any OpenAI-compatible endpoint), `anthropic` SDK, `axios` for custom providers

---

## ENTRY POINT

```
src/index.ts → startClawLite()
```

This is the main function that initializes everything in order. See CLAWSPEC.md Section 17 (Startup Sequence in CHANNEL_ADAPTERS.md) for the exact boot order.

---

## PROJECT STRUCTURE

```
clawlite/
├── package.json
├── tsconfig.json
├── CLAUDE.md                          ← this file
├── specs/                             ← architecture specs (read-only reference)
│   ├── CLAWSPEC.md
│   ├── TASKGRAPH_ENGINE.md
│   ├── CHANNEL_ADAPTERS.md
│   ├── TOOL_SDK.md
│   └── WORKER_AGENTS.md
├── src/
│   ├── index.ts                       ← entry point: startClawLite()
│   ├── core/
│   │   ├── config.ts                  ← load config.json, validate with Zod
│   │   ├── secrets.ts                 ← load .env, ctx.secrets.get(), appendToEnvFile()
│   │   ├── logger.ts                  ← structured JSON logger with levels
│   │   └── events.ts                  ← EventEmitter for graph and progress events
│   ├── db/
│   │   ├── schema.ts                  ← CREATE TABLE statements, migrations
│   │   ├── connection.ts              ← better-sqlite3 init with FTS5, WAL mode
│   │   ├── jobs.ts                    ← job CRUD
│   │   ├── nodes.ts                   ← node CRUD, status transitions (transactional)
│   │   ├── runs.ts                    ← run tracking
│   │   ├── artifacts.ts               ← artifact storage (text + file)
│   │   ├── approvals.ts              ← pending approval CRUD
│   │   ├── memory.ts                  ← memory CRUD + FTS5 search
│   │   ├── sessions.ts               ← conversational session CRUD
│   │   ├── subAgents.ts              ← sub-agent profile CRUD
│   │   ├── dailyBudget.ts            ← single-row budget table
│   │   └── ledger.ts                  ← ledger entry CRUD
│   ├── llm/
│   │   ├── provider.ts                ← llm.complete() with provider switch
│   │   ├── resolveModel.ts           ← tier → model ID resolution
│   │   └── providers/                 ← per-provider call implementations
│   │       ├── openrouter.ts
│   │       ├── anthropic.ts
│   │       ├── openai.ts
│   │       ├── google.ts
│   │       ├── openaiCompatible.ts    ← used by xAI, DeepSeek, Groq, Ollama, custom
│   │       └── mistral.ts
│   ├── router/
│   │   ├── messageRouter.ts           ← chat/command/complex classification
│   │   ├── subAgentRouter.ts          ← route to correct sub-agent based on intent
│   │   └── heuristics.ts             ← isSimpleChat() keyword detection
│   ├── planner/
│   │   ├── templates.ts               ← built-in template definitions
│   │   ├── yamlLoader.ts             ← load .clawlite/templates/*.yaml
│   │   ├── templateSelector.ts        ← LLM classification + confidence scoring
│   │   ├── slotExtractor.ts          ← extract slots from user message
│   │   ├── buildTaskGraph.ts          ← instantiate template into graph
│   │   └── agenticFallback.ts        ← bounded agentic plan generation + validation
│   ├── executor/
│   │   ├── executeJob.ts              ← main execution loop (event-driven)
│   │   ├── runNode.ts                 ← single node execution
│   │   ├── circuitBreakers.ts         ← hard limit checks (per-job + daily + agentic)
│   │   ├── graphValidation.ts         ← DAG validation (cycles, nodes, agents, models)
│   │   ├── topologicalSort.ts         ← Kahn's algorithm
│   │   └── approvalHandler.ts         ← approval request + resolution via events
│   ├── workers/
│   │   ├── registry.ts                ← WorkerRegistry, dispatch by node type
│   │   ├── types.ts                   ← WorkerAgent, WorkerResult interfaces
│   │   ├── context.ts                 ← buildToolContext() utility
│   │   ├── WorkspaceAgent.ts          ← Gmail, Calendar, Drive via gws CLI
│   │   ├── ResearchAgent.ts           ← Perplexity Sonar search + deep research
│   │   ├── PublisherAgent.ts          ← approval-gated content publishing
│   │   ├── AggregatorAgent.ts         ← format upstream artifacts into summary
│   │   └── BuilderAgent.ts            ← generate tools, templates, sub-agents
│   ├── tools/
│   │   ├── sdk/
│   │   │   ├── types.ts               ← ToolDefinition, ToolContext, ToolRisk
│   │   │   ├── registry.ts            ← ToolRegistry, auto-discovery, hot-loading
│   │   │   ├── invokeTool.ts          ← pipeline: validate → permissions → budget → dry run → ledger
│   │   │   └── securityAnalysis.ts    ← scan tool code for critical/warning/info issues
│   │   ├── builtin/
│   │   │   ├── workspace.tool.ts      ← gws CLI wrapper (gmail, calendar, drive)
│   │   │   ├── research.tool.ts       ← Perplexity API wrapper (sonar, sonar-deep-research)
│   │   │   └── fs.tool.ts             ← sandboxed local filesystem
│   │   ├── custom/                    ← user-installed and agent-generated tools
│   │   └── installer.ts              ← clawlite tool install, version pinning, tools.lock.json
│   ├── memory/
│   │   ├── retrieve.ts                ← tag match + FTS5 search, token budget enforcement
│   │   ├── store.ts                   ← ingestMemory() with size gate + duplicate gate
│   │   └── prune.ts                   ← daily pruning, TTL expiry, hard cap enforcement
│   ├── session/
│   │   ├── sessionManager.ts          ← store turns, retrieve context, compaction
│   │   └── compaction.ts             ← summarize old turns, store as episodic memory
│   ├── channels/
│   │   ├── types.ts                   ← ChannelAdapter, InboundMessage, OutboundMessage, ApprovalRequest
│   │   ├── registry.ts               ← ChannelRegistry, startAll(), stopAll()
│   │   ├── adapters/
│   │   │   ├── telegram.ts            ← node-telegram-bot-api polling adapter
│   │   │   ├── whatsapp.ts            ← Baileys adapter
│   │   │   ├── discord.ts             ← discord.js adapter
│   │   │   ├── slack.ts               ← @slack/bolt adapter
│   │   │   └── webchat.ts             ← WebSocket + static SPA adapter
│   │   ├── handlers/
│   │   │   ├── message.ts             ← shared message handler (auth → session → route)
│   │   │   ├── chat.ts                ← lightweight chat path (fast tier + session context)
│   │   │   ├── complex.ts             ← template selection → job creation
│   │   │   ├── commands.ts            ← all slash command handlers
│   │   │   ├── systemCommands.ts      ← /status, /budget, /agents, /tools, /templates
│   │   │   ├── profileCommands.ts     ← /remember, /forget, /profile
│   │   │   ├── heartbeatCommands.ts   ← /heartbeat list/add/remove/now
│   │   │   └── fileUpload.ts          ← handle attachments, store as artifacts
│   │   ├── shared/
│   │   │   ├── auth.ts                ← per-channel allowlist enforcement
│   │   │   ├── longMessage.ts         ← split messages per channel limits
│   │   │   ├── retry.ts              ← sendWithRetry() with exponential backoff
│   │   │   ├── approval.ts            ← channel-agnostic approval flow
│   │   │   ├── progress.ts            ← attachProgressListener()
│   │   │   └── recovery.ts            ← recoverChannelState() on startup
│   │   └── webchat/
│   │       └── static/                ← HTML/CSS/JS for the browser chat UI
│   ├── http/
│   │   ├── server.ts                  ← Fastify init, route registration
│   │   ├── webhooks.ts               ← POST /hooks/:templateId
│   │   ├── artifacts.ts              ← GET /artifacts/:id
│   │   └── status.ts                 ← GET /status
│   ├── heartbeat/
│   │   ├── scheduler.ts              ← setInterval, fire heartbeat events
│   │   └── checker.ts                ← read HEARTBEAT.md, single LLM classification call
│   ├── policies/
│   │   ├── budgets.ts                 ← checkDailyBudget(), recordTokenUsage()
│   │   ├── permissions.ts             ← tool permission checks
│   │   └── approvalGates.ts          ← which actions require approval
│   └── cli/
│       ├── index.ts                   ← command parser and dispatcher
│       ├── setup.ts                   ← onboarding wizard (all 11 steps)
│       ├── daemon.ts                  ← start/stop/restart/status + service install
│       ├── config.ts                  ← config get/set/show/validate
│       ├── logs.ts                    ← log tailing and filtering
│       ├── jobs.ts                    ← job listing and detail
│       ├── budget.ts                  ← budget display
│       ├── memory.ts                  ← memory listing, search
│       ├── agents.ts                  ← sub-agent listing and management
│       ├── tools.ts                   ← tool install/list/info/update/remove/scan/audit
│       ├── templates.ts               ← template listing and validation
│       ├── reset.ts                   ← destructive reset commands
│       ├── db.ts                      ← backup, vacuum, stats
│       ├── send.ts                    ← terminal message sending
│       └── dryrun.ts                  ← dry run from terminal
└── test/
    ├── db/                            ← schema, CRUD operations
    ├── llm/                           ← mock provider responses
    ├── tools/                         ← tool pipeline, security analysis
    ├── executor/                      ← DAG execution, circuit breakers
    ├── router/                        ← message classification
    ├── planner/                       ← template selection, slot extraction
    ├── workers/                       ← each worker with mock tools
    └── channels/                      ← adapter message flow
```

---

## BUILD ORDER

**Implement phases in order. Test each phase before moving to the next.** Each phase builds on the previous one. Do not skip ahead.

### Phase 1: Project Scaffold + Database
**Goal:** Runnable TypeScript project with initialized SQLite database.

1. Initialize project: `npm init`, `tsconfig.json` (strict mode, ES2022, Node resolution)
2. Install core dependencies: `better-sqlite3`, `zod`, `dotenv`
3. Implement `src/db/connection.ts` — open SQLite with WAL mode and FTS5
4. Implement `src/db/schema.ts` — all CREATE TABLE statements from CLAWSPEC.md Section 19:
   - `jobs`, `nodes`, `runs`, `ledger`, `memory`, `memory_fts`, `daily_budget`, `sessions`, `sub_agents`, `approvals`, `pending_revisions`, `artifacts`
5. Implement all `src/db/*.ts` CRUD modules — one per table
6. Implement `src/core/config.ts` — Zod schema for config.json, loader, validator
7. Implement `src/core/secrets.ts` — dotenv loader, `secrets.get()`, `appendToEnvFile()`
8. Implement `src/core/logger.ts` — structured JSON logger with debug/info/warn/error levels
9. Implement `src/core/events.ts` — shared EventEmitter for graph and progress events

**Test:** Create database, run all migrations, insert/query test data for each table.

### Phase 2: LLM Provider Abstraction
**Goal:** Can call any LLM provider and get a typed response.

1. Implement `src/llm/resolveModel.ts` — tier name → model ID from config
2. Implement `src/llm/provider.ts` — the `llm.complete()` function with provider switch
3. Implement each provider in `src/llm/providers/`:
   - `openrouter.ts` — OpenRouter API (OpenAI-compatible with extra headers)
   - `anthropic.ts` — Anthropic Messages API via `@anthropic-ai/sdk`
   - `openai.ts` — OpenAI Chat Completions via `openai` SDK
   - `google.ts` — Google AI Studio / Gemini API
   - `openaiCompatible.ts` — generic handler for xAI, DeepSeek, Groq, Ollama, custom
   - `mistral.ts` — Mistral API
4. All providers must return the same `LLMResponse` type: `{ text: string; parsed?: any; usage: { total_tokens: number } }`
5. Support `format: "json"` parameter that adds JSON mode instructions to the prompt

**Test:** Call each provider with a simple prompt, verify response format. Mock responses for unit tests.

### Phase 3: Tool SDK (Foundation)
**Goal:** Tools can be defined, registered, validated, and invoked through a single pipeline.

1. Implement `src/tools/sdk/types.ts` — `ToolDefinition`, `ToolContext`, `ToolRisk`, `WorkerResult`
   - Include `requiredSecrets` field on ToolDefinition (see TOOL_SDK.md Section 4)
2. Implement `src/tools/sdk/registry.ts` — auto-scan `tools/builtin/*.tool.ts` and `tools/custom/*.tool.ts`, register, name collision check, hot-loading file watcher
3. Implement `src/tools/sdk/invokeTool.ts` — the mandatory pipeline from TOOL_SDK.md Section 10:
   - Zod schema validation → permission check → budget check → dry run interception → execute → ledger log
4. Implement the three built-in tools:
   - `workspace.tool.ts` — wraps `gws` CLI via `child_process.spawn`. NDJSON parsing. See TOOL_SDK.md Section 11.1
   - `research.tool.ts` — wraps Perplexity Sonar API (basic search via `sonar`, deep research via `sonar-deep-research`). Route through OpenRouter or direct based on config. See CLAWSPEC.md Step 5
   - `fs.tool.ts` — sandboxed read/write within `.clawlite/workspace/`. See TOOL_SDK.md Section 11.3
5. Implement `src/tools/sdk/securityAnalysis.ts` — the full scanner from TOOL_SDK.md Section 14a (critical/warning/info checks, shell detection, fs escape, obfuscation, prompt injection, etc.)
6. Implement `src/tools/installer.ts` — `clawlite tool install` flow: download from GitHub/MCP, run security analysis, prompt user, install to tools/custom/, write tools.lock.json

**Test:** Invoke each built-in tool with mock gws/Perplexity responses. Test security scanner against known-bad patterns. Test dry run mode.

### Phase 4: Memory + Session
**Goal:** Persistent memory with FTS5 search and conversational session history.

1. Implement `src/memory/store.ts` — `ingestMemory()` with size gate (300 tokens), duplicate gate (FTS5 score > 0.85), TTL
2. Implement `src/memory/retrieve.ts` — tag match first, FTS5 second, max 3 items, max 500 tokens total
3. Implement `src/memory/prune.ts` — daily pruning: expire old episodic, enforce 500 item cap
4. Implement `src/session/sessionManager.ts` — store user/assistant turns per chat+channel, retrieve last N turns
5. Implement `src/session/compaction.ts` — when total tokens exceed threshold, summarize old turns via fast tier, store as episodic memory, delete compacted turns

**Test:** Store and retrieve memories. Verify FTS5 ranking. Verify session compaction.

### Phase 5: Task Graph Engine
**Goal:** Template graphs can be loaded, validated, instantiated, and executed as parallel DAGs.

1. Implement `src/planner/templates.ts` — the 8 built-in template definitions from TASKGRAPH_ENGINE.md Section 7
2. Implement `src/planner/yamlLoader.ts` — parse YAML templates from `.clawlite/templates/`, validate, register
3. Implement `src/planner/templateSelector.ts` — slash command direct match → LLM classification with confidence scoring. See TASKGRAPH_ENGINE.md Section 6
4. Implement `src/planner/slotExtractor.ts` — fast tier LLM extracts structured data from user message
5. Implement `src/planner/buildTaskGraph.ts` — instantiate template with filled slots into job + nodes in SQLite
6. Implement `src/planner/agenticFallback.ts` — bounded agentic plan generation: LLM generates plan JSON → validate as DAG → convert to TaskGraph. Hard limits: 5 iterations, 10 nodes, 30K tokens. See TASKGRAPH_ENGINE.md Section 6a
7. Implement `src/executor/graphValidation.ts` — validate DAG (unique IDs, valid deps, no cycles, known agents, valid models, node count)
8. Implement `src/executor/topologicalSort.ts` — Kahn's algorithm
9. Implement `src/executor/circuitBreakers.ts` — check all hard limits before every node dispatch and LLM call. See TASKGRAPH_ENGINE.md Section 10
10. Implement `src/executor/approvalHandler.ts` — store pending approval, wait for event, resume/reject/revise
11. Implement `src/executor/runNode.ts` — dispatch to correct worker, handle dry run, handle approval, handle retry
12. Implement `src/executor/executeJob.ts` — the event-driven execution loop from TASKGRAPH_ENGINE.md Section 13: schedule runnable nodes → react to completion/failure events → check job completion

**Test:** Execute a simple template (e.g., inbox_assistant with mock tools). Test parallel node execution. Test circuit breaker tripping. Test approval flow with mock channel.

### Phase 6: Workers
**Goal:** All 5 workers can execute their node types and return structured results.

1. Implement `src/workers/types.ts` — `WorkerAgent`, `WorkerResult` interfaces
2. Implement `src/workers/context.ts` — `buildToolContext()` that assembles ToolContext for a node
3. Implement `src/workers/registry.ts` — register workers, route by node type pattern
4. Implement each worker per WORKER_AGENTS.md:
   - `WorkspaceAgent.ts` — gmail.*, calendar.*, drive.* node types
   - `ResearchAgent.ts` — research.search, research.deep, research.summarize
   - `PublisherAgent.ts` — publish.draft_posts, publish.tweet, etc. (all approval-gated)
   - `AggregatorAgent.ts` — reads upstream artifacts, produces summary via fast tier
   - `BuilderAgent.ts` — build.generate_tool, build.generate_template, build.generate_subagent (all approval-gated). See WORKER_AGENTS.md Section 15

**Test:** Each worker with mock upstream artifacts and mock tool responses.

### Phase 7: Message Router
**Goal:** Incoming messages are correctly classified and dispatched.

1. Implement `src/router/heuristics.ts` — `isSimpleChat()` keyword/pattern detection
2. Implement `src/router/messageRouter.ts` — three-path router (chat/command/complex). See CLAWSPEC.md Section 3
3. Implement `src/router/subAgentRouter.ts` — fast tier LLM classifies which sub-agent handles the message. See CLAWSPEC.md Section 10a.4
4. Wire up command handlers:
   - `src/channels/handlers/commands.ts` — workflow commands (/inbox, /today, /draft, etc.)
   - `src/channels/handlers/systemCommands.ts` — /status, /budget, /agents, /tools, /templates, /jobs
   - `src/channels/handlers/profileCommands.ts` — /remember, /forget, /profile (updates USER.md)
   - `src/channels/handlers/heartbeatCommands.ts` — /heartbeat list/add/remove/now
5. Implement `src/channels/handlers/chat.ts` — lightweight chat path: load session context + memory, call fast tier, store response in session
6. Implement `src/channels/handlers/complex.ts` — template selection → job creation → execute. Fallback to agentic if low confidence
7. Implement `src/channels/handlers/fileUpload.ts` — download attachment, store as artifact, acknowledge

**Test:** Route test messages to correct handlers. Test command parsing. Test chat path with session context.

### Phase 8: Channel Adapters
**Goal:** Messages flow in and out of messaging platforms.

1. Implement `src/channels/types.ts` — `ChannelAdapter`, `InboundMessage`, `OutboundMessage`, `ApprovalRequest`, `ApprovalAction`
2. Implement `src/channels/registry.ts` — register enabled adapters, startAll(), stopAll()
3. Implement `src/channels/shared/` — auth, longMessage, retry, approval, progress, recovery
4. Implement `src/channels/handlers/message.ts` — the shared handler that wires auth → session → file upload → revision check → route
5. **Implement Telegram first** (`src/channels/adapters/telegram.ts`) — polling, inline keyboard for approvals, callback queries. This is the easiest to test. See CHANNEL_ADAPTERS.md Section 8
6. **Implement WebChat second** (`src/channels/adapters/webchat.ts`) — WebSocket on Fastify, static SPA serving. See CHANNEL_ADAPTERS.md Section 12
7. Implement Discord, Slack, WhatsApp adapters. See CHANNEL_ADAPTERS.md Sections 9-11

**Test:** Send a message via Telegram → get a response. Test approval buttons. Test progress updates. Test file upload.

### Phase 9: HTTP Server
**Goal:** Webhooks, artifact viewer, and status API are operational.

1. Implement `src/http/server.ts` — Fastify init with CORS, multipart, static, websocket plugins
2. Implement `src/http/webhooks.ts` — `POST /hooks/:templateId?token=SECRET`. See CLAWSPEC.md Section 21
3. Implement `src/http/artifacts.ts` — `GET /artifacts/:id` with markdown/HTML rendering
4. Implement `src/http/status.ts` — `GET /status` returning system state JSON

**Test:** POST a webhook → verify job created. GET an artifact. GET status.

### Phase 10: Heartbeat + Cron
**Goal:** Proactive checks and scheduled jobs fire correctly.

1. Implement `src/heartbeat/scheduler.ts` — setInterval based on config, fire heartbeat events
2. Implement `src/heartbeat/checker.ts` — read HEARTBEAT.md, single fast-tier LLM call, structured JSON response, trigger template if action needed. See CLAWSPEC.md Section 8a
3. Implement cron job registration and firing for sub-agents

**Test:** Heartbeat fires and triggers a job. Cron schedule creates a job at the right time.

### Phase 11: Self-Building (Operator-as-Orchestrator)
**Goal:** The Operator can create new tools, templates, and sub-agents through conversation.

1. Implement sub-agent creation flow — Operator interprets user request, assembles profile, requests approval. See CLAWSPEC.md Section 10a.3
2. Implement tool generation flow — BuilderAgent generates TypeScript, security analysis runs, user approves, installed to tools/custom/. See CLAWSPEC.md Section 10a.1
3. Implement template authoring flow — BuilderAgent generates YAML, validates DAG, user approves, saved to templates/. See CLAWSPEC.md Section 10a.2
4. Implement agentic-to-template promotion — save successful agentic plans as reusable templates. See TASKGRAPH_ENGINE.md Section 7a
5. Implement in-chat API key collection — `requestSecret()` flow from CLAWSPEC.md Section 15b
6. Wire up `/build` command and natural language detection for capability-building requests

**Test:** Ask the Operator to create a new sub-agent → verify tool generated → security scan → template created → sub-agent profile saved.

### Phase 12: CLI
**Goal:** Full terminal command surface for daemon management, diagnostics, and maintenance.

1. Implement `src/cli/index.ts` — command parser (use `commander` or `yargs`)
2. Implement `src/cli/setup.ts` — the 11-step onboarding wizard from CLAWSPEC.md Section 7a
3. Implement `src/cli/daemon.ts` — start (foreground + --daemon), stop, restart, status. Service installation for launchd/systemd. See CLAWSPEC.md Section 7b
4. Implement all other CLI commands per CLAWSPEC.md Section 7b:
   - config get/set/show/validate
   - logs (--follow, --level, --since)
   - jobs, job <id>
   - budget
   - memory, memory search
   - agents, agent <name>
   - tool install/list/info/update/remove/scan/audit
   - templates, template <id>, template validate
   - reset (--sessions, --memory, --jobs, --all)
   - db backup/vacuum/stats
   - send, dryrun, heartbeat --now
5. Register `bin` in package.json pointing to compiled CLI entry point

**Test:** Each CLI command produces correct output. Daemon starts and stops cleanly.

### Phase 13: Crash Recovery + Polish
**Goal:** Production-ready resilience and UX.

1. Implement graceful shutdown — SIGINT/SIGTERM handler from CLAWSPEC.md Section 7b
2. Implement crash recovery — reset `running` nodes to `pending`, re-attach progress listeners, re-send pending approvals. See TASKGRAPH_ENGINE.md Section 30a
3. Implement hot-loading for tools (file watcher on tools/custom/) and templates (file watcher on templates/)
4. Implement config hot-reload for budgets and hardLimits (no restart needed)
5. Add exit codes (0-5) per CLAWSPEC.md Section 7b
6. Build WebChat static SPA (HTML + CSS + vanilla JS, no build step)
7. End-to-end integration test: onboarding → start → chat → job → approval → complete

---

## CRITICAL RULES (from CLAWSPEC.md Section 28)

1. **No infinite loops.** Event-driven graph execution only. Bounded agentic has hard iteration limits.
2. **Not every message is a job.** Chat path is lightweight (~200 tokens). Only complex requests create jobs.
3. **Every node has an explicit model tier.** No defaulting to expensive models.
4. **Circuit breakers are non-negotiable.** Check before every node dispatch and every LLM call.
5. **Templates before freeform.** Use existing templates when possible. Agentic fallback for edge cases.
6. **Channel-agnostic core.** Router, executor, workers, memory never reference a specific platform.
7. **Heartbeat is one LLM call.** Classification only — it triggers template jobs, never runs tools directly.
8. **Operator builds, sub-agents execute.** Clear separation of concerns.
9. **User approves all capability changes.** No silent tool installation, template creation, or sub-agent creation.
10. **Generated code is untrusted.** Security analysis runs on everything, including Operator-generated tools.
11. **Conversation-first.** User should never need an editor or terminal to manage the system.

---

## CODING STANDARDS

- TypeScript strict mode, no `any` types except where interfacing with external APIs
- Small, single-responsibility modules — max ~200 lines per file
- All database writes in explicit SQLite transactions
- All tool calls through `invokeTool()` pipeline — no direct `child_process` or HTTP calls outside tools
- Zod validation on all external inputs (config, API responses, user commands, generated plans)
- Structured JSON logging — never `console.log` in production code
- Every error path must: log the error, update relevant status in DB, notify user if applicable
- Node status transitions are always atomic (transaction wrapping status + output update)
- Ledger entries written BEFORE actions (intent log), updated AFTER (result log)

---

## TESTING APPROACH

- **Unit tests** for each module in isolation (mock dependencies)
- **Integration tests** for critical flows: message → route → job → execute → respond
- **Mock LLM responses** for deterministic testing (don't call real APIs in CI)
- **Mock tool responses** for testing executor without real gws/Perplexity
- **Real channel tests** require a Telegram bot token — document as manual test
- Security analysis scanner should have its own test suite with known-good and known-bad tool samples

---

## DEPENDENCIES TO INSTALL

```bash
# Core
npm install typescript @types/node tsx
npm install better-sqlite3 @types/better-sqlite3
npm install fastify @fastify/websocket @fastify/multipart @fastify/static
npm install zod dotenv axios

# LLM providers
npm install openai @anthropic-ai/sdk

# Channel adapters (install based on enabled channels)
npm install node-telegram-bot-api @types/node-telegram-bot-api
npm install @whiskeysockets/baileys    # WhatsApp
npm install discord.js                  # Discord
npm install @slack/bolt                 # Slack

# CLI
npm install commander                   # or yargs

# Google Workspace
npm install -g @anthropic-ai/gws       # gws CLI (global)

# Dev
npm install -D vitest @types/node
```

---

## WHAT NOT TO BUILD (v2 — deferred)

- BrowserAgent / Playwright automation
- ReviewerAgent / quality checks
- Embedding-based memory (stick with FTS5)
- Web dashboard (WebChat covers the basic UI need)
- Plugin marketplace with remote registry
- Multi-user / team mode
- Sub-agent budget enforcement as hard limits (advisory for MVP)
- Additional channels: Signal, iMessage, Matrix

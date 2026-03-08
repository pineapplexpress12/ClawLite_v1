# WORKER_AGENTS.md
## Project: ClawLite
### Worker Agent Specification (Stateless Executors, Tool SDK Consumers)

---

## 1. PURPOSE

Worker Agents are the executors of ClawLite's task graph. Each worker:

- Receives a `TaskNode` from the executor
- Reads upstream artifacts and memory
- Calls tools via the Tool SDK
- Uses the model specified in `node.model` (not a default)
- Returns a structured `WorkerResult`
- Never holds state — all state lives in SQLite

This spec defines the interface, responsibilities, prompt design, and implementation requirements for every built-in worker agent.

---

## 2. CORE PRINCIPLES

| Principle | Description |
|-----------|-------------|
| **Stateless** | Workers hold no memory between invocations |
| **Tool SDK only** | All external calls go through `invokeTool()` |
| **Structured output** | Every worker returns typed `WorkerResult` |
| **Single responsibility** | Each worker handles one domain only |
| **Model-aware** | Workers use `node.model`, never a hardcoded default |
| **Auditable** | All actions logged via ledger automatically |
| **Composable** | Output artifacts flow into downstream nodes |

---

## 3. BASE WORKER INTERFACE

All workers must implement this interface:

```typescript
import { TaskNode } from "../executor/types";
import { ToolContext } from "../tools/sdk/types";

export interface WorkerResult {
  output: Record<string, any>;
  artifacts: {
    type: string;
    title: string;
    content?: string;
    path?: string;
    metadata?: Record<string, any>;
  }[];
  costTokens: number;
  status: "completed" | "waiting_approval" | "failed";
  failureReason?: string;
}

export interface WorkerAgent {
  name: string;
  supportedNodeTypes: string[];
  execute(node: TaskNode, ctx: ToolContext): Promise<WorkerResult>;
}
```

---

## 4. WORKER REGISTRY

Workers are registered at startup.

```typescript
export interface WorkerRegistry {
  register(agent: WorkerAgent): void;
  get(agentName: string): WorkerAgent;
  list(): { name: string; supportedNodeTypes: string[] }[];
}
```

### MVP Worker Routing

| Node Type Pattern | Worker |
|-------------------|--------|
| `research.*` | ResearchAgent |
| `gmail.*` / `calendar.*` / `drive.*` | WorkspaceAgent |
| `publish.*` / `post.*` | PublisherAgent |
| `aggregate` | AggregatorAgent |

v2 worker routing is defined in the appendix (Section A1).

---

## 5. UPSTREAM ARTIFACT RESOLUTION

Before execution, every worker must resolve upstream artifacts.

```typescript
async function resolveUpstreamArtifacts(
  node: TaskNode,
  db: Database
): Promise<Artifact[]> {
  const upstreamNodeIds = node.dependencies;
  return db.getArtifactsByNodeIds(upstreamNodeIds);
}
```

Artifacts are passed into the worker's LLM prompt or tool calls as structured context.

**Rule:** Never pass raw full text into prompts blindly. Summarize or select relevant fields.

---

## 6. WORKER PROMPT STRUCTURE

Every worker that calls an LLM must use this prompt structure:

```
SYSTEM:
You are [AgentName], a specialized AI worker in the ClawLite system.
Your role: [one sentence description]
You must respond only in structured JSON matching the required output schema.
Do not include explanations or preamble outside the JSON block.

USER:
## Goal
[node.description]

## Upstream Context
[summarized upstream artifacts]

## Memory
[retrieved memory snippets, max 3 items]

## Available Tools
[tool names and descriptions]

## Output Schema
[JSON schema for expected output]

## Instructions
[specific task instructions for this worker type]
```

**Model selection:** The worker reads `node.model` and calls the corresponding LLM. Workers never hardcode a model name.

```typescript
const response = await llm.complete({
  model: node.model,  // from template — e.g. "fast", "balanced", "strong"
  messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }]
});
```

---

## 7. RESEARCH AGENT (MVP)

### Purpose

Performs web research using Perplexity's Sonar and Deep Research APIs.

### Supported node types

```
research.search
research.deep
research.summarize
```

### Tool usage

```typescript
// Standard search
const result = await invokeTool("research", { action: "search", query: node.input.query }, ctx);

// Deep research
const result = await invokeTool("research", { action: "deep", query: node.input.query }, ctx);
```

### Output schema

```typescript
interface ResearchOutput {
  summary: string;
  keyInsights: string[];
  sources: { title: string; url: string; snippet: string }[];
  citations: string[];
  rawReportArtifactId: string;
}
```

### Artifacts produced

- `research_report` — full Perplexity response stored as text artifact
- `research_summary` — condensed insights for downstream nodes

### Model assignment

- `research.search` → `balanced`
- `research.deep` → `balanced`
- `research.summarize` → `balanced`

### Prompt instructions

```
Extract the most important facts and insights from the research.
Return structured JSON with summary, key insights, and citations.
Do not fabricate sources. Only include sources returned by the API.
```

### Error handling

- If Perplexity API fails → retry once → log failure → return partial result with error flag
- If query is too vague → return `{ status: "needs_clarification", question: "..." }`

---

## 8. WORKSPACE AGENT (MVP)

### Purpose

Manages Gmail, Google Calendar, and Google Drive via the `gws` CLI tool.

### Supported node types

```
gmail.list
gmail.fetch
gmail.draft
gmail.send
gmail.summarize
calendar.list
calendar.propose
calendar.create
drive.list
drive.upload
drive.share
```

### Tool usage

```typescript
// List unread emails
const emails = await invokeTool("workspace", {
  action: "gmail.list",
  params: { query: "is:unread", maxResults: 20 }
}, ctx);

// Draft a reply
const draft = await invokeTool("workspace", {
  action: "gmail.draft.create",
  params: { to, subject, body, threadId }
}, ctx);

// Send requires approval — tool handles approval gate internally
const send = await invokeTool("workspace", {
  action: "gmail.send",
  params: { draftId }
}, ctx);
```

### Output schema

```typescript
// gmail.list
interface GmailListOutput {
  messages: {
    id: string;
    threadId: string;
    subject: string;
    from: string;
    date: string;
    snippet: string;
    labels: string[];
  }[];
  totalCount: number;
}

// gmail.draft
interface GmailDraftOutput {
  draftId: string;
  to: string;
  subject: string;
  bodyPreview: string;
  artifactId: string;
}

// calendar.create
interface CalendarCreateOutput {
  eventId: string;
  title: string;
  start: string;
  end: string;
  attendees: string[];
  approvalId?: string; // set if waiting_approval
}
```

### Model assignment

- `gmail.list` / `gmail.fetch` / `calendar.list` → `fast` (data retrieval, no reasoning needed)
- `gmail.summarize` / `gmail.draft` / `calendar.propose` → `balanced` (needs quality)
- `gmail.send` / `calendar.create` → `fast` (execution only, no LLM reasoning)

### Approval gating

WorkspaceAgent must request approval before:
- Sending any email
- Creating calendar events with external attendees
- Sharing Drive files externally

```typescript
// Before sending email
const { approvalId } = await ctx.approvals.request({
  actionType: "send_email",
  title: `Send to ${to}`,
  preview: `Subject: ${subject}\n\n${bodyPreview}`,
  data: { draftId, to, subject }
});
return { status: "waiting_approval", approvalId };
```

### Prompt instructions

```
You are managing Google Workspace on behalf of the user.
When drafting emails, match the user's tone: professional but direct.
Never invent email addresses or calendar details.
Always confirm attendee names from upstream context before scheduling.
```

---

## 9. PUBLISHER AGENT (MVP)

### Purpose

Publishes or delivers final outputs — social posts, notifications, formatted summaries.

### Supported node types

```
publish.draft_posts
publish.tweet
publish.linkedin
publish.telegram_message
publish.notify
```

### Tool usage

```typescript
// All publish actions require approval
const { approvalId } = await ctx.approvals.request({
  actionType: "post_social_media",
  title: "Post to Twitter",
  preview: node.input.content,
  data: { platform: "twitter", content: node.input.content }
});
return { status: "waiting_approval", approvalId };
```

### Output schema

```typescript
interface PublisherOutput {
  platform: string;
  action: string;
  preview: string;
  publishedUrl?: string;
  approvalId?: string;
  status: "published" | "waiting_approval" | "failed";
}
```

### Model assignment

- `publish.draft_posts` → `balanced` (creative writing)
- `publish.tweet` / `publish.linkedin` / `publish.notify` → `fast` (formatting/execution only)

### Approval gating

**All PublisherAgent external actions require approval.** No exceptions.

```typescript
const ALWAYS_REQUIRES_APPROVAL = [
  "publish.tweet",
  "publish.linkedin",
  "publish.telegram_message"
];
```

`publish.draft_posts` does NOT require approval — it only drafts content for review.

### Prompt instructions

```
You are a publishing agent. Your only job is to format and submit final outputs.
When drafting posts, use the upstream research and insights.
Never modify approved content — only publish exactly what was approved.
Always request approval before any external publish action.
```

---

## 10. OPERATOR AGENT (SPECIAL — NOT A WORKER)

### Purpose

The Operator Agent is not a worker — it is the orchestrator. It routes messages, selects templates, and delivers results to the user.

### Responsibilities

1. Route incoming message (chat/command/complex)
2. For chat: respond directly with `fast` tier model
3. For command: select template, fill slots
4. For complex: classify into best-match template, fill slots
5. Persist job + graph to SQLite
6. Start executor
7. Monitor job progress
8. Send progress updates to Telegram
9. Deliver the AggregatorAgent's final summary to the user when job completes

### Operator is NOT a worker

The Operator does not execute nodes. It does not generate summaries. It only:
- Routes messages
- Creates jobs
- Monitors execution
- Delivers results produced by workers (including AggregatorAgent's summary)

**The AggregatorAgent is the sole owner of final summary generation.** The Operator receives the summary artifact and forwards it to the user via Telegram. It does not re-summarize, re-format, or make an additional LLM call.

### Operator persona is config-driven (UPDATED — PERSONA.md support)

The operator name and persona are read from `PERSONA.md` (if it exists) or `config.json` — never hardcoded in source. This makes ClawLite reusable for any bot without editing source code.

**Persona loading priority:**
1. `.clawlite/PERSONA.md` — rich markdown file (max 1000 tokens)
2. `config.agents[profile].persona` — profile-specific override
3. `config.operator.persona` — default fallback

```typescript
function loadPersona(profile: string = "default"): string {
  // 1. PERSONA.md takes priority
  const personaFile = readFileSafe(".clawlite/PERSONA.md");
  if (personaFile) {
    return truncateToTokens(personaFile, 1000);
  }

  // 2. Agent profile persona override
  const profileConfig = config.agents?.[profile];
  if (profileConfig?.persona) {
    return profileConfig.persona;
  }

  // 3. Default config persona
  return config.operator.persona;
}
```

**USER.md integration:**

If `.clawlite/USER.md` exists, its content (max 500 tokens) is appended to worker prompts under a `## User Context` section. This gives workers awareness of user preferences, contacts, and project context without bloating the core persona.

```typescript
function loadUserContext(): string | null {
  const userFile = readFileSafe(".clawlite/USER.md");
  if (!userFile) return null;
  return truncateToTokens(userFile, 500);
}
```

### Agent profiles (NEW)

Agent profiles allow different configurations for different contexts. A cron job can run as a "content" profile (research-focused, balanced default) while interactive messages use the "default" profile.

```typescript
interface AgentProfile {
  persona?: string;           // overrides PERSONA.md / operator.persona
  tools: string[];            // tool allowlist for this profile
  defaultTier: "fast" | "balanced" | "strong";
}
```

Profiles are defined in `config.json` under `agents`:

```json
{
  "agents": {
    "default": {
      "tools": ["workspace", "research"],
      "defaultTier": "fast"
    },
    "content": {
      "persona": "You are a content strategist focused on AI and tech topics.",
      "tools": ["research"],
      "defaultTier": "balanced"
    }
  }
}
```

Jobs reference profiles via `job.agentProfile`. Workers resolve their tool allowlist and persona from the active profile.

### Operator model usage

| Task | Model |
|------|-------|
| Message routing / classification | `fast` |
| Simple chat response | `fast` |
| Template slot extraction | `fast` |

The Operator does not run a model for job summaries — that is the AggregatorAgent's job. The Operator should almost never use an expensive model. Its job is coordination, not reasoning.

### Operator prompt structure

```
SYSTEM:
[config.operator.persona]

USER:
## User Message
[telegram message text]

## Recent Memory
[top 3 relevant memory items]

## Active Jobs
[any currently running jobs]

## Available Capabilities
[list of enabled tools and agents]
```

---

## 11. WORKER EXECUTION CONTEXT

Every worker receives a fully-populated `ToolContext`. The executor is responsible for building this before dispatching.

```typescript
function buildToolContext(job: Job, node: TaskNode, db: Database): ToolContext {
  return {
    jobId: job.id,
    nodeId: node.id,
    agentName: node.assignedAgent,
    dryRun: job.dryRun,
    budget: {
      remainingToolCalls: job.maxToolCalls - db.countToolCalls(job.id),
      remainingTimeMs: job.budgetTimeMs - (Date.now() - job.createdAt)
    },
    policy: {
      allowPermissions: node.toolPermissions,
      requireApprovalFor: config.approvalPolicy.actions
      // v2: add allowedDomains here when BrowserAgent ships
    },
    ledger: { log: (entry) => db.insertLedgerEntry(entry) },
    approvals: {
      request: (payload) => db.createPendingApproval(node.id, payload)
    },
    artifacts: {
      writeText: (params) => db.storeTextArtifact(job.id, node.id, params),
      writeFile: (params) => db.storeFileArtifact(job.id, node.id, params)
    },
    secrets: {
      get: (key) => config.secrets?.[key]
    }
  };
}
```

---

## 12. MEMORY RETRIEVAL PER WORKER

Each worker should retrieve memory before execution:

```typescript
const memoryItems = await memory.retrieve(node.description, 3);  // max 3 items
```

Memory is injected into the worker's LLM prompt under the `## Memory` section.

Workers must NOT store memory themselves. Memory storage is handled by the executor after node completion based on artifact outputs.

---

## 13. TOKEN COST TRACKING

Every worker must return `costTokens` in its `WorkerResult`.

```typescript
const response = await llm.complete({
  model: node.model,
  messages: [...]
});

return {
  output: parsed,
  artifacts: [...],
  costTokens: response.usage.total_tokens,
  status: "completed"
};
```

The executor subtracts `costTokens` from `job.budgetTokens` after each node.

---

## 14. ERROR RECOVERY RULES

| Scenario | Behavior |
|----------|----------|
| LLM returns malformed JSON | Retry once with stricter prompt, then fail node |
| Tool call fails | Retry up to `node.maxRetries`, then fail node |
| Approval rejected | Mark node `cancelled`, optionally create revision node |
| Budget exhausted mid-node | Fail node, halt job |
| Circuit breaker tripped | Cancel node, fail job immediately |
| Upstream artifact missing | Fail node with `missing_dependency` reason |

---

## 15. BUILDER AGENT (MVP — NEW)

### Purpose

The BuilderAgent is the Operator's construction arm. It generates tools, templates, and sub-agent configurations when the user needs capabilities that don't exist yet. It is the agent that makes ClawLite self-building.

### Supported node types

```
build.generate_tool         — generate a new tool file from API description
build.generate_template     — generate a YAML template from workflow description
build.generate_subagent     — generate a sub-agent profile
build.modify_tool           — update an existing tool (add actions, fix bugs)
build.modify_template       — update an existing template
```

### v2 node types (deferred)

```
build.scaffold              — scaffold a full project
build.generate_component    — generate a code component
build.git_commit            — commit to git
build.git_push              — push to remote (approval required)
deploy.vercel_staging       — deploy to staging (approval required)
deploy.vercel_production    — deploy to production (approval required)
```

### Tool generation flow

```typescript
const BuilderAgent: WorkerAgent = {
  name: "BuilderAgent",
  supportedNodeTypes: [
    "build.generate_tool", "build.generate_template", "build.generate_subagent",
    "build.modify_tool", "build.modify_template"
  ],

  async execute(node: TaskNode, ctx: ToolContext): Promise<WorkerResult> {
    switch (node.type) {

      case "build.generate_tool": {
        // 1. Research the API if needed (delegate to ResearchAgent upstream)
        const apiSpec = node.input.apiSpec ?? node.input.apiDescription;

        // 2. Generate tool code using balanced tier
        const code = await llm.complete({
          model: node.model,  // balanced
          messages: [{
            role: "system",
            content: `You are a tool generator for ClawLite. Generate a TypeScript tool file that follows the ToolDefinition interface exactly.

Requirements:
- Import { z } from "zod" and { ToolDefinition } from "../sdk/types"
- Define a Zod schema for all parameters
- Declare permissions for each action (format: "toolname.action")
- Set requiresApproval: true for any create/delete/send/publish/deploy actions
- Include a mockHandler for dry run support
- Use ctx.secrets.get() for API keys — NEVER hardcode credentials
- Return structured JSON from the handler — no raw text
- Handle errors gracefully with try/catch

API to integrate: ${apiSpec}
Tool name: ${node.input.toolName}
Actions needed: ${JSON.stringify(node.input.actions)}`
          }]
        });

        // 3. Write to temp file
        const tempPath = writeTempFile(node.input.toolName, code.text);

        // 4. Run security analysis (MANDATORY — even for our own generated code)
        const security = await analyzeToolSecurity(tempPath);

        return {
          output: {
            toolPath: tempPath,
            securityReport: security,
            requiresUserApproval: true
          },
          artifacts: [{
            type: "generated_tool",
            title: `Tool: ${node.input.toolName}`,
            content: code.text,
            metadata: { securityScore: security.score, issues: security.warnings.length }
          }],
          costTokens: code.usage.total_tokens,
          status: security.passed ? "waiting_approval" : "failed",
          failureReason: security.passed ? undefined : `Security analysis failed: ${security.criticalIssues.map(i => i.code).join(", ")}`
        };
      }

      case "build.generate_template": {
        const yaml = await llm.complete({
          model: node.model,  // balanced
          messages: [{
            role: "system",
            content: `You are a template generator for ClawLite. Generate a YAML template file for a task graph workflow.

Requirements:
- Valid YAML following the GraphTemplate schema
- Each node must have: id, type, title, agent, model (fast|balanced|strong), dependencies, requiresApproval
- Graph must be a valid DAG (no cycles)
- Use the cheapest appropriate model tier for each node
- Set requiresApproval: true for any external/irreversible actions
- Total nodes should not exceed 15

Available tools: ${JSON.stringify(ctx.policy.allowPermissions)}
Available workers: WorkspaceAgent, ResearchAgent, PublisherAgent, AggregatorAgent, BuilderAgent`
          }, {
            role: "user",
            content: `Workflow description: ${node.input.workflowDescription}\nTemplate name: ${node.input.templateName}`
          }],
        });

        // Validate the generated template
        const template = parseYAML(yaml.text);
        const errors = validateTemplate(template);

        return {
          output: {
            templateYaml: yaml.text,
            templateId: node.input.templateName,
            validationErrors: errors,
            requiresUserApproval: true
          },
          artifacts: [{
            type: "generated_template",
            title: `Template: ${node.input.templateName}`,
            content: yaml.text
          }],
          costTokens: yaml.usage.total_tokens,
          status: errors.length === 0 ? "waiting_approval" : "failed",
          failureReason: errors.length > 0 ? `Template validation failed: ${errors.join(", ")}` : undefined
        };
      }

      case "build.generate_subagent": {
        // Sub-agent profile generation is mostly configuration assembly
        // Verify all referenced tools and templates exist
        const profile = {
          name: node.input.name,
          description: node.input.description,
          persona: node.input.persona,
          tools: node.input.tools,
          templates: node.input.templates,
          defaultTier: node.input.defaultTier ?? "balanced",
          budgetTokensDaily: node.input.budgetTokensDaily ?? 50000,
          cronJobs: node.input.cronJobs ?? [],
          heartbeatConditions: node.input.heartbeatConditions ?? []
        };

        return {
          output: { profile, requiresUserApproval: true },
          artifacts: [{
            type: "generated_subagent",
            title: `Sub-agent: ${profile.name}`,
            content: JSON.stringify(profile, null, 2)
          }],
          costTokens: 0,  // no LLM call needed for assembly
          status: "waiting_approval"
        };
      }

      // ... modify_tool and modify_template are similar but operate on existing files
    }
  }
};
```

### Model assignment

- `build.generate_tool` → `balanced` (needs quality code generation)
- `build.generate_template` → `balanced` (needs workflow reasoning)
- `build.generate_subagent` → `fast` (mostly configuration assembly)
- `build.modify_*` → `balanced` (needs understanding of existing code)

### Approval gating

**ALL BuilderAgent outputs require user approval.** The BuilderAgent never installs a tool, saves a template, or creates a sub-agent without the user explicitly confirming. This is enforced at the worker level — every build node returns `status: "waiting_approval"`.

---

## 16. MVP IMPLEMENTATION CHECKLIST

- [ ] `WorkerAgent` interface and `WorkerResult` type
- [ ] `WorkerRegistry` with auto-registration
- [ ] `buildToolContext()` utility (with `dryRun` flag)
- [ ] `resolveUpstreamArtifacts()` utility
- [ ] ResearchAgent (Perplexity search + deep)
- [ ] WorkspaceAgent (gmail list, fetch, draft, send, summarize, calendar list, create)
- [ ] PublisherAgent (approval-gated draft/post)
- [ ] AggregatorAgent (format upstream artifacts into user summary)
- [ ] **BuilderAgent (tool generation, template authoring, sub-agent creation)**
- [ ] OperatorAgent (router, sub-agent routing, template selector, capability builder)
- [ ] **Sub-agent routing (Operator classifies and delegates to correct sub-agent)**
- [ ] Token cost tracking per worker
- [ ] Memory injection per worker (max 3 items, max 500 tokens)
- [ ] Model selection from `node.model` (no hardcoded defaults)

---

# APPENDIX: v2 AND FUTURE WORKERS

> **Everything below this line is deferred. Do not implement any of it during MVP. It is included here only as forward-looking design reference.**

---

## A1. v2 WORKERS (After core is stable)

These ship alongside their corresponding v2 tools (see `TOOL_SDK.md` Section 12).

### Browser Agent

Automates browser interactions using Playwright.

**Supported node types:** `browser.navigate`, `browser.extract`, `browser.fill_form`, `browser.screenshot`, `browser.scrape`

**Requires:** `browser.tool.ts` (Playwright)

### Reviewer Agent

Reviews code, drafts, or plans produced by other agents.

**Supported node types:** `review.code`, `review.draft_email`, `review.plan`, `review.research`, `test.validate_output`

**Requires:** No additional tools (LLM-only, reads upstream artifacts)

---

## A2. FUTURE WORKERS (No timeline)

Once the base system is running, new workers can be added without touching core:

| Worker | Purpose |
|--------|---------|
| `AnalyticsAgent` | Query SQLite data, generate reports |
| `FinanceAgent` | Stripe read-only summaries, expense tracking |
| `SupportAgent` | Respond to customer tickets |
| `SocialAgent` | Multi-platform scheduling and engagement |
| `MonitorAgent` | Watch for errors, uptime issues, alerts |

---

*Next recommended spec: **`CHANNEL_ADAPTERS.md`** — defines the multi-channel abstraction layer, per-channel implementations, approvals, and progress updates.*

*The five core spec files are:*
- *`CLAWSPEC.md` — system overview, operator-as-orchestrator, self-building, sub-agents, heartbeat, sessions, HTTP server*
- *`TASKGRAPH_ENGINE.md` — template graphs (built-in + YAML), DAG executor, bounded agentic fallback, hard limits*
- *`CHANNEL_ADAPTERS.md` — multi-channel abstraction, per-channel implementations*
- *`TOOL_SDK.md` — tool/plugin architecture, tool installation + security analysis, tool generation*
- *`WORKER_AGENTS.md` — this file, MVP 5 workers (including BuilderAgent), sub-agent execution model*

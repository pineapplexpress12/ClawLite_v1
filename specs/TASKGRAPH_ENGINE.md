# TASKGRAPH_ENGINE.md
## Project: ClawLite
### Task Graph Planner and Executor Specification

---

## 1. PURPOSE

The Task Graph Engine is the central execution system for ClawLite.

Its job is to:

1. Match user requests to **predefined template graphs** (MVP), use the **bounded agentic fallback** for unmatched requests, or generate custom DAGs (v2)
2. Fill template slots with extracted parameters (or validate LLM-generated plans in agentic mode)
3. Schedule graph nodes in the correct order
4. Run independent nodes in parallel
5. Assign nodes to specialized worker agents with explicit model tiers
6. Track budgets, retries, and failures
7. Enforce hard circuit breakers at the job level
8. Pause for approvals when needed
9. Persist all state in SQLite

This system replaces OpenClaw-style infinite thinking loops with a **deterministic, event-driven execution model**.

---

## 2. HIGH LEVEL FLOW

The engine operates in five stages:

```text
1. Receive routed request (from message router — not raw user input)
2. Select template graph OR classify into best-match template
   2a. If confidence < 0.7 and >= 0.3: invoke bounded agentic fallback (Section 6a)
3. Fill template slots with user parameters (or validate agentic plan as DAG)
4. Run nodes based on dependencies
5. Aggregate outputs and return result
```

---

## 3. CORE CONCEPTS

### 3.1 Job

A Job is the top-level execution unit.

**Example:**
```text
"Check unread emails, draft replies, and schedule follow-ups."
```

A Job contains:
- Goal
- Graph
- Status
- Budget
- Hard limits
- Dry run flag
- Ledger entries
- Outputs

---

### 3.2 Node

A Node is a single executable task within the graph.

**Examples:**
- Fetch emails
- Summarize emails
- Draft replies
- Create calendar event
- Run research

Each Node must be small enough to:
- Run independently
- Produce a clear output
- Be assigned to one worker agent
- Use one specific model tier

---

### 3.3 Edge

An Edge represents a dependency between two nodes.

**Example:**
```text
Fetch Emails → Summarize Emails → Draft Replies
```

A node cannot run until all dependency nodes are completed.

---

### 3.4 Artifact

An Artifact is a structured output produced by a node.

**Examples:**
- Email summary JSON
- Draft reply text
- Research report
- Deployment URL

Artifacts are persisted and passed between nodes.

---

### 3.5 Worker Agent

A Worker Agent is a specialized executor.

**MVP:** WorkspaceAgent, ResearchAgent, PublisherAgent, AggregatorAgent

Each worker:
- Receives a node
- Executes it using the model specified in `node.model`
- Returns structured output

Workers are stateless. All persistent state is stored externally.

---

## 4. GRAPH DATA MODEL

```typescript
type NodeStatus =
  | "pending"
  | "queued"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

interface TaskNode {
  id: string;
  jobId: string;
  type: string;
  title: string;
  description: string;
  status: NodeStatus;
  assignedAgent: string;
  model: "fast" | "balanced" | "strong";  // abstract tier — resolved to provider model at runtime
  dependencies: string[];
  input: Record<string, any>;
  output: Record<string, any> | null;
  artifactIds: string[];
  toolPermissions: string[];
  requiresApproval: boolean;
  retryCount: number;
  maxRetries: number;
  timeoutMs: number;
  tokenBudget: number;
  createdAt: number;
  updatedAt: number;
}

interface TaskGraph {
  jobId: string;
  nodes: TaskNode[];
}
```

---

## 5. JOB DATA MODEL

```typescript
type JobStatus =
  | "pending"
  | "planning"
  | "ready"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

interface Job {
  id: string;
  goal: string;
  status: JobStatus;
  triggerType: "channel_message" | "cron" | "webhook" | "heartbeat" | "system";
  channel: string;           // NEW: "telegram", "whatsapp", "discord", "slack"
  chatId: string;            // NEW: channel-specific chat ID (was number)
  jobType: "template" | "agentic";  // NEW: template graph or bounded agentic plan
  agentProfile: string;      // NEW: which agent profile to use (default: "default")
  dryRun: boolean;
  budgetTokens: number;
  budgetTimeMs: number;
  maxParallelWorkers: number;
  totalLLMCalls: number;     // counter — incremented per LLM call
  totalRetries: number;      // counter — incremented per retry
  createdAt: number;
  updatedAt: number;
}
```

---

## 6. TEMPLATE GRAPH SYSTEM (MVP PLANNER)

### Why templates instead of freeform planning

Freeform DAG generation is the biggest source of:
- Wasted tokens (the planning call itself is expensive)
- Bad graphs (wrong dependencies, missing approval gates, hallucinated node types)
- Retry loops (invalid graph → re-plan → invalid again)

For MVP, the planner selects from predefined templates and fills slots. This is:
- **Cheap:** Classification is a tiny LLM call (or keyword matching for slash commands)
- **Reliable:** Templates are tested and validated at design time
- **Fast:** No graph generation latency

Templates can come from three sources:
1. **Built-in templates** — hardcoded in the codebase (the 8 MVP templates)
2. **YAML templates** — user-authored or agent-generated files in `.clawlite/templates/` (see Section 6b)
3. **Promoted agentic plans** — bounded agentic fallback results saved as reusable templates

### Template structure

```typescript
interface GraphTemplate {
  id: string;
  name: string;
  description: string;          // clear verb+noun — used by LLM classifier
  subAgent?: string;            // NEW: which sub-agent owns this template (null = global)
  slashCommand?: string;        // e.g. "/inbox", "/research"
  slots: {
    name: string;
    description: string;
    required: boolean;
    default?: any;
  }[];
  nodes: Omit<TaskNode, "id" | "jobId" | "status" | "output" | "artifactIds" | "createdAt" | "updatedAt">[];
}
```

### Template selection flow

Template selection is a three-tier cascade. The design is deliberately conservative: keyword matching is fast but brittle, so the LLM classifier acts as the safety net. **The quality of the user experience depends on the template library being small, well-curated, and non-overlapping.** A bad taxonomy here makes the whole system feel dumb regardless of architecture.

```typescript
async function selectTemplate(
  message: string,
  templates: GraphTemplate[]
): Promise<{ template: GraphTemplate; slots: Record<string, any>; confidence: number }> {

  // 1. Slash command — direct match, no LLM, 100% confidence
  const slashMatch = templates.find(t => t.slashCommand && message.startsWith(t.slashCommand));
  if (slashMatch) {
    const args = message.replace(slashMatch.slashCommand!, "").trim();
    return { template: slashMatch, slots: extractSlashArgs(slashMatch, args), confidence: 1.0 };
  }

  // 2. LLM classification — always runs for freeform messages
  //    Keyword heuristics are too fragile to trust alone.
  //    A single cheap LLM call (~100 tokens) is more reliable than substring matching.
  const classification = await classifyIntent(message, templates);

  // 3. Confidence gate — if the classifier is uncertain, ask the user
  if (classification.confidence < 0.7) {
    return {
      template: CLARIFICATION_PSEUDO_TEMPLATE,
      slots: { originalMessage: message, topCandidates: classification.topN },
      confidence: classification.confidence
    };
  }

  const slots = await extractSlots(classification.template, message);
  return { template: classification.template, slots, confidence: classification.confidence };
}
```

### Intent classification prompt

The classifier returns a template ID and confidence score. The prompt is designed to be unambiguous:

```typescript
async function classifyIntent(
  message: string,
  templates: GraphTemplate[]
): Promise<{ template: GraphTemplate; confidence: number; topN: string[] }> {
  const templateList = templates.map(t =>
    `- id: "${t.id}" — ${t.description}`
  ).join("\n");

  const prompt = `You are a request classifier. Given the user message below, select the BEST matching template.

Available templates:
${templateList}

User message: "${message}"

Respond with JSON only:
{
  "templateId": "string — the best match, or 'none' if nothing fits",
  "confidence": number between 0.0 and 1.0,
  "topCandidates": ["id1", "id2"] — top 2 candidates if ambiguous
}`;

  const result = await llm.complete({ model: "fast", prompt, format: "json" });

  if (result.templateId === "none") {
    return { template: FALLBACK_CHAT_TEMPLATE, confidence: 0.0, topN: [] };
  }

  const matched = templates.find(t => t.id === result.templateId);
  return {
    template: matched ?? FALLBACK_CHAT_TEMPLATE,
    confidence: result.confidence,
    topN: result.topCandidates ?? []
  };
}
```

### Confidence-based fallback behavior

| Confidence | Behavior |
|-----------|----------|
| ≥ 0.9 | Execute template immediately |
| 0.7 – 0.9 | Execute template, but include template name in "Job started" message so user can correct |
| < 0.7 | Ask user to clarify: "I'm not sure what you need. Did you mean: [candidate 1] or [candidate 2]?" |
| 0.0 / "none" | Fall through to chat path — respond conversationally |

---

## 6a. BOUNDED AGENTIC FALLBACK (NEW)

When the template classifier returns confidence between 0.3 and 0.7, the request is legitimate but doesn't match any template well. Instead of asking for clarification (which feels dumb) or forcing an ill-fitting template, the bounded agentic fallback lets the LLM generate a one-off execution plan — but with all safety rails intact.

### Flow

```typescript
async function handleAgenticFallback(
  message: string,
  opts: { triggerType: string; channel: string; chatId: string; dryRun: boolean }
): Promise<Job> {

  // 1. Ask the balanced-tier LLM to generate a plan
  const planResponse = await llm.complete({
    model: "balanced",
    messages: [{
      role: "system",
      content: `You are a task planner. Given the user's request, generate a plan as a JSON array of steps.
Each step must have: id, type (must be a known tool/node type), title, description, dependencies (array of step ids), model ("fast"|"balanced"), requiresApproval (boolean).
Max ${config.hardLimits.agenticMaxNodes} steps. Only use these tool types: ${knownToolTypes.join(", ")}.
Respond with JSON only.`
    }, {
      role: "user",
      content: message
    }],
    format: "json"
  });

  // 2. Validate the plan as a valid DAG
  const plan = parsePlan(planResponse.parsed);
  validateAgenticPlan(plan);  // throws if invalid

  // 3. Create a job with tighter limits
  const job = await db.createJob({
    goal: message,
    triggerType: opts.triggerType,
    channel: opts.channel,
    chatId: opts.chatId,
    jobType: "agentic",
    dryRun: opts.dryRun,
    budgetTokens: Math.min(config.hardLimits.agenticMaxTokenBudget, config.budgets.perJobTokens)
  });

  // 4. Convert plan into TaskGraph nodes
  const nodes = plan.map(step => ({
    ...step,
    jobId: job.id,
    status: "pending",
    tokenBudget: Math.floor(config.hardLimits.agenticMaxTokenBudget / plan.length),
    maxRetries: 1  // tighter retry budget for agentic plans
  }));

  await db.createGraph(job.id, nodes);
  return job;
}

function validateAgenticPlan(plan: any[]) {
  if (!Array.isArray(plan)) throw new Error("Plan must be an array");
  if (plan.length > config.hardLimits.agenticMaxNodes) throw new Error("Plan exceeds max nodes");
  if (plan.length === 0) throw new Error("Plan is empty");

  // Validate DAG — no cycles
  if (!isAcyclic(plan)) throw new Error("Plan contains cycles");

  // Validate all tool types are known
  for (const step of plan) {
    if (!knownToolTypes.includes(step.type)) {
      throw new Error(`Unknown tool type: ${step.type}`);
    }
  }

  // Validate all dependency IDs reference real steps
  const ids = new Set(plan.map(s => s.id));
  for (const step of plan) {
    for (const dep of step.dependencies ?? []) {
      if (!ids.has(dep)) throw new Error(`Unknown dependency: ${dep}`);
    }
  }
}
```

### Safety guarantees

The bounded agentic fallback produces a job that is **identical in structure** to a template job. It runs through the same executor, same circuit breakers, same approval gates, same budget tracking. The only difference is how the graph was generated (LLM vs template). This means:

- Max 10 nodes (vs 20 for templates)
- Max 30,000 token budget (vs 50,000 for templates)
- Max 1 retry per node (vs configurable for templates)
- All approval gates still enforced
- All tool permissions still enforced
- Circuit breakers still checked at every node dispatch

**Template taxonomy rules (for authors, not runtime):**

1. Templates must have **non-overlapping descriptions**. If "check email" could match both "inbox assistant" and "draft reply," the taxonomy is broken.
2. Keep the library **under 12 templates** for MVP. More templates = more classifier confusion.
3. Every template must have a **clear verb + noun** description: "List unread emails," not "Email stuff."
4. Test the classifier against 50+ example messages before shipping. Log misclassifications during beta.

### Slot extraction

Slot extraction uses a `fast` tier model to pull structured data from the user message:

```typescript
async function extractSlots(
  template: GraphTemplate,
  message: string
): Promise<Record<string, any>> {
  // fast tier call with structured output
  const prompt = `Extract these fields from the user message:
${template.slots.map(s => `- ${s.name}: ${s.description}${s.required ? " (required)" : " (optional)"}`).join("\n")}

User message: "${message}"

Respond with JSON only. Use null for optional fields that are not mentioned.`;

  return await llm.complete({ model: "fast", prompt, format: "json" });
}
```

---

## 7. MVP TEMPLATE LIBRARY

### Template A — Inbox Assistant

**Trigger:** `/inbox` or "check my email", "unread emails", "inbox"

```
Slots: { maxResults: number (default 20) }

Nodes:
1. gmail.list      → WorkspaceAgent [fast]    — list unread
2. gmail.summarize → WorkspaceAgent [balanced]   — summarize threads (depends: 1)
3. aggregate       → AggregatorAgent  [fast]    — format response (depends: 2)
```

### Template B — Draft Reply

**Trigger:** `/draft` or "reply to", "draft a response", "write back to"

```
Slots: { threadId?: string, instructions?: string }

Nodes:
1. gmail.fetch     → WorkspaceAgent [fast]    — fetch thread
2. gmail.draft     → WorkspaceAgent [balanced]   — draft reply (depends: 1)
3. aggregate       → AggregatorAgent  [fast]    — show draft preview (depends: 2)
```

### Template C — Send Email

**Trigger:** `/send` or "send the draft", "send it"

```
Slots: { draftId: string }

Nodes:
1. gmail.send      → WorkspaceAgent [fast]    — send (approval required)
```

### Template D — Today's Calendar

**Trigger:** `/today` or "what's on my calendar", "schedule today"

```
Slots: { date: string (default today) }

Nodes:
1. calendar.list   → WorkspaceAgent [fast]    — fetch events
2. aggregate       → AggregatorAgent  [fast]    — format response (depends: 1)
```

### Template E — Schedule Event

**Trigger:** `/schedule` or "create a meeting", "schedule a call", "book time"

```
Slots: { title: string, date: string, time: string, duration?: number, attendees?: string[] }

Nodes:
1. calendar.create → WorkspaceAgent [balanced]   — create event (approval required)
```

### Template F — Deep Research

**Trigger:** `/research <query>` or "research", "look into", "find out about"

```
Slots: { query: string }

Nodes:
1. research.deep   → ResearchAgent  [balanced]   — run Perplexity deep research
2. research.summarize → ResearchAgent [balanced]  — extract key insights (depends: 1)
3. aggregate       → AggregatorAgent  [fast]    — format response (depends: 2)
```

### Template G — Research to Posts

**Trigger:** "research and write tweets", "write posts about", "content about"

```
Slots: { query: string, count: number (default 4), platform: string (default "twitter") }

Nodes:
1. research.deep       → ResearchAgent  [balanced]   — deep research
2. research.summarize  → ResearchAgent  [balanced]   — key insights (depends: 1)
3. publish.draft_posts → PublisherAgent [balanced]   — draft posts (depends: 2)
4. publish.post        → PublisherAgent [fast]    — post (approval required, depends: 3)
```

### Template H — Email + Calendar Combo

**Trigger:** "check email and schedule follow-ups", "inbox and meetings"

```
Slots: { maxResults: number (default 20) }

Nodes:
1. gmail.list        → WorkspaceAgent [fast]    — list unread
2. calendar.list     → WorkspaceAgent [fast]    — today's events (parallel with 1)
3. gmail.summarize   → WorkspaceAgent [balanced]   — summarize threads (depends: 1)
4. gmail.draft_replies → WorkspaceAgent [balanced] — draft replies (depends: 3)
5. calendar.propose  → WorkspaceAgent [balanced]   — propose follow-ups (depends: 3, 2)
6. aggregate         → AggregatorAgent  [fast]    — combined summary (depends: 4, 5)
```

---

## 7a. YAML TEMPLATE AUTHORING (NEW)

Beyond the 8 built-in templates, ClawLite supports user-authored and agent-generated templates stored as YAML files in `.clawlite/templates/`. This is what makes ClawLite a general-purpose platform — new workflows can be created through conversation or by hand without touching the codebase.

### Template file format

```yaml
# .clawlite/templates/weekly_report.yaml
id: weekly_report
name: "Weekly Business Report"
description: "Generate a weekly summary of email activity, calendar, and open tasks"
subAgent: inbox           # which sub-agent owns this (optional)
slashCommand: /weekly     # register as a slash command (optional)

slots:
  - name: weekStart
    description: "Start date of the week (default: last Monday)"
    required: false
    default: "last_monday"

nodes:
  - id: fetch_emails
    type: gmail.list
    title: "Fetch this week's emails"
    agent: WorkspaceAgent
    model: fast
    dependencies: []
    requiresApproval: false
    input:
      query: "after:{{slots.weekStart}}"
      maxResults: 100

  - id: fetch_calendar
    type: calendar.list
    title: "Fetch this week's events"
    agent: WorkspaceAgent
    model: fast
    dependencies: []    # parallel with fetch_emails
    requiresApproval: false

  - id: analyze
    type: llm.analyze
    title: "Analyze weekly activity"
    agent: ResearchAgent
    model: balanced
    dependencies: [fetch_emails, fetch_calendar]
    requiresApproval: false
    input:
      prompt: "Summarize this week's email and calendar activity. Highlight key decisions, pending items, and suggested follow-ups."

  - id: report
    type: aggregate
    title: "Format weekly report"
    agent: AggregatorAgent
    model: fast
    dependencies: [analyze]
    requiresApproval: false
```

### Template loading

At startup, the template library loads from two sources:

1. Built-in templates (hardcoded — the 8 MVP templates)
2. YAML files from `.clawlite/templates/*.yaml`

A file watcher on the templates directory hot-loads new or modified templates without restart.

```typescript
async function loadAllTemplates(): Promise<void> {
  // 1. Load built-in templates
  for (const builtin of builtinTemplates) {
    templates.register(builtin);
  }

  // 2. Load YAML templates
  const yamlFiles = glob.sync(".clawlite/templates/*.yaml");
  for (const file of yamlFiles) {
    try {
      const yaml = fs.readFileSync(file, "utf-8");
      const template = parseAndValidateTemplate(yaml);
      templates.register(template);
    } catch (err) {
      logger.warn(`Failed to load template ${file}: ${err.message}`);
    }
  }

  // 3. Watch for new/modified templates
  watchTemplateDirectory();
}
```

### Template validation

All YAML templates go through the same validation as built-in templates:

1. All node IDs are unique
2. All dependency references are valid
3. No cycles (valid DAG)
4. All agent names are registered workers
5. All model tiers are valid
6. All tool types reference installed tools
7. Approval gates set on dangerous actions
8. Total nodes ≤ `hardLimits.maxNodesPerJob`
9. Template ID is unique (no collision with built-in or other YAML templates)

### Agentic-to-template promotion

When the bounded agentic fallback generates a plan that executes successfully, the Operator can offer to save it as a reusable YAML template:

```typescript
async function promoteAgenticPlanToTemplate(
  job: Job,
  graph: TaskGraph,
  suggestedName: string,
  slashCommand?: string
): Promise<string> {
  // Convert the executed graph back to YAML template format
  const yaml = graphToYaml(graph, {
    id: slugify(suggestedName),
    name: suggestedName,
    description: job.goal,
    slashCommand,
    subAgent: job.subAgentId
  });

  // Validate
  const errors = validateTemplate(parseYAML(yaml));
  if (errors.length > 0) {
    throw new Error(`Cannot promote: ${errors.join(", ")}`);
  }

  // Save
  const filename = `${slugify(suggestedName)}.yaml`;
  fs.writeFileSync(path.join(".clawlite/templates", filename), yaml);
  templates.register(parseYAML(yaml));

  return filename;
}
```

This means ClawLite **learns new workflows over time**: a one-off request becomes a bounded agentic job → if it works well, the user promotes it to a template → next time it's a single slash command.

### CLI commands for templates

| Command | Description |
|---------|-------------|
| `clawlite templates` | List all templates (built-in + YAML) |
| `clawlite template <id>` | Show template detail |
| `clawlite template validate <file>` | Validate a YAML template file |
| `clawlite template delete <id>` | Delete a YAML template (cannot delete built-ins) |

---

## 8. PLANNING RULES

### Rule 1: Nodes must be atomic

Each node should do one clear thing only.

✅ **Good:**
- Fetch unread emails
- Summarize one thread
- Create one draft reply

❌ **Bad:**
- Read all emails, summarize them, draft replies, schedule events

---

### Rule 2: Use specialized workers

Assign each node to the narrowest possible agent.

| Task Type | Agent |
|-----------|-------|
| Research | ResearchAgent |
| Gmail / Calendar | WorkspaceAgent |
| Output delivery / posting | PublisherAgent |

---

### Rule 3: Parallelize where possible

If two nodes do not depend on each other, they should run in parallel.

**Example — these can all run simultaneously:**
```text
List unread emails
Check calendar
```

---

### Rule 4: Approval for dangerous actions

Any node that performs an external, public, or irreversible action must set:

```typescript
requiresApproval = true
```

**Applies to:**
- Send email
- Create calendar invite
- Post tweet
- Share drive file externally

---

### Rule 5: Acyclic only

Graphs must not contain cycles.

---

### Rule 6: Artifact-driven outputs

Each node must output structured artifacts. Artifacts should be machine-readable when possible.

---

### Rule 7: Every node has an explicit model (NEW)

No node may rely on a default model. The template assigns the cheapest appropriate model to each node.

---

## 9. EXECUTOR RESPONSIBILITIES

1. Load the graph from SQLite
2. Check hard circuit breakers before each node
3. Identify runnable nodes
4. Enforce concurrency limit
5. Dispatch nodes to workers with correct model
6. Update status
7. Handle completion / failure / retry
8. Pause for approval when required
9. End the job when all nodes finish

---

## 10. HARD CIRCUIT BREAKERS (NEW — CRITICAL)

Before every node dispatch and every LLM call, the executor checks:

```typescript
function checkCircuitBreakers(job: Job, requiredTokens?: number): { ok: boolean; reason?: string } {
  const limits = config.hardLimits;

  // Daily budget — check whether the NEXT node's estimated cost fits, not just whether budget > 0
  const dailyBudget = checkDailyBudget(requiredTokens ?? 0);
  if (!dailyBudget.ok) {
    return { ok: false, reason: `daily_budget_exhausted (need ${requiredTokens ?? 0}, have ${dailyBudget.remaining})` };
  }

  if (db.countNodes(job.id) > limits.maxNodesPerJob) {
    return { ok: false, reason: "max_nodes_exceeded" };
  }

  if (job.totalLLMCalls >= limits.maxTotalLLMCalls) {
    return { ok: false, reason: "max_llm_calls_exceeded" };
  }

  if (Date.now() - job.createdAt > limits.maxJobDurationMs) {
    return { ok: false, reason: "max_duration_exceeded" };
  }

  if (job.totalRetries >= limits.maxRetriesTotalPerJob) {
    return { ok: false, reason: "max_retries_exceeded" };
  }

  return { ok: true };
}
```

**Node-aware dispatch:** When scheduling a node, pass `node.tokenBudget` so the breaker rejects before dispatch if the daily budget can't cover it:

```typescript
// In scheduleRunnableNodes():
const breakers = checkCircuitBreakers(job, node.tokenBudget);

// In runNode():
const breakers = checkCircuitBreakers(job, node.tokenBudget);
```

If any breaker trips:
1. Job status → `failed`
2. All running nodes → `cancelled`
3. User notified via Telegram with reason
4. Ledger entry logged

**These limits are non-negotiable. They exist specifically to prevent OpenClaw-style runaway loops.**

The daily budget check (`checkDailyBudget`) is defined in `CLAWSPEC.md` Section 17. It uses a single-row `daily_budget` SQLite table with a rolling 24-hour window. Every node completion and every chat response decrements it.

---

## 11. EXECUTION ALGORITHM

```text
while job is not completed:
    check circuit breakers → halt if tripped
    load graph
    find runnable nodes
    enqueue runnable nodes
    dispatch up to maxParallelWorkers
    wait for node events (completion / failure / approval)
    update graph state
    increment job counters (totalLLMCalls, totalRetries)
    repeat
```

---

## 12. RUNNABLE NODE RULE

A node is runnable if:

1. Status is `pending`
2. All dependency nodes are `completed`
3. Job budget is not exhausted
4. Circuit breakers are not tripped
5. A concurrency slot is available

```typescript
function isRunnable(node: TaskNode, graph: TaskGraph, job: Job): boolean {
  if (node.status !== "pending") return false;

  const breakers = checkCircuitBreakers(job, node.tokenBudget);
  if (!breakers.ok) return false;

  return node.dependencies.every(depId => {
    const dep = graph.nodes.find(n => n.id === depId);
    return dep?.status === "completed";
  });
}
```

---

## 13. EXECUTOR PSEUDOCODE

The executor uses an **event-driven pattern** — nodes emit completion/failure events and the executor reacts immediately. No polling loops.

```typescript
import { EventEmitter } from "events";

const graphEvents = new EventEmitter();

async function executeJob(jobId: string) {
  const job = db.getJob(jobId);

  // Check circuit breakers before starting
  const breakers = checkCircuitBreakers(job);
  if (!breakers.ok) {
    db.updateJobStatus(jobId, "failed");
    notifyUser(job.chatId, `❌ Job killed: ${breakers.reason}`);
    return;
  }

  // Kick off initial runnable nodes
  await scheduleRunnableNodes(jobId);

  // React to node state changes immediately
  graphEvents.on(`node:completed:${jobId}`, async () => {
    await scheduleRunnableNodes(jobId);
    checkJobCompletion(jobId);
  });

  graphEvents.on(`node:failed:${jobId}`, async (nodeId: string) => {
    const node = db.getNode(nodeId);
    const job = db.getJob(jobId);

    // Increment job-level retry counter
    db.incrementJobRetries(jobId);

    if (node.retryCount < node.maxRetries) {
      db.incrementRetryCount(nodeId);
      db.updateNodeStatus(nodeId, "pending");
      await scheduleRunnableNodes(jobId);
    } else if (anyUnrecoverableFailure(db.getGraph(jobId))) {
      db.updateJobStatus(jobId, "failed");
      graphEvents.removeAllListeners(`node:completed:${jobId}`);
      graphEvents.removeAllListeners(`node:failed:${jobId}`);
    }
  });
}

async function scheduleRunnableNodes(jobId: string) {
  const job = db.getJob(jobId);
  const graph = db.getGraph(jobId);

  // Circuit breaker check before scheduling
  const breakers = checkCircuitBreakers(job);
  if (!breakers.ok) {
    db.updateJobStatus(jobId, "failed");
    notifyUser(job.chatId, `❌ Job killed: ${breakers.reason}`);
    return;
  }

  const runningCount = db.countRunningNodes(jobId);
  const runnableNodes = graph.nodes.filter(n => isRunnable(n, graph, job));

  for (const node of runnableNodes) {
    if (runningCount >= job.maxParallelWorkers) break;
    db.updateNodeStatus(node.id, "queued");
    // Fire and forget — node emits event on completion
    runNode(node.id).then(() => {
      graphEvents.emit(`node:completed:${jobId}`, node.id);
    }).catch(() => {
      graphEvents.emit(`node:failed:${jobId}`, node.id);
    });
  }
}

function checkJobCompletion(jobId: string) {
  const graph = db.getGraph(jobId);
  if (allNodesCompleted(graph)) {
    db.updateJobStatus(jobId, "completed");
    graphEvents.removeAllListeners(`node:completed:${jobId}`);
    graphEvents.removeAllListeners(`node:failed:${jobId}`);
  }
}
```

---

## 14. NODE LIFECYCLE

**Happy path:**
```text
pending → queued → running → completed
```

**Approval path:**
```text
running → waiting_approval → completed
```

**Retry path:**
```text
running → failed → retry → running
```

---

## 15. NODE EXECUTION FUNCTION

```typescript
async function runNode(nodeId: string) {
  const node = db.getNode(nodeId);
  const job = db.getJob(node.jobId);

  // Circuit breaker check
  const breakers = checkCircuitBreakers(job, node.tokenBudget);
  if (!breakers.ok) {
    db.updateNodeStatus(nodeId, "cancelled");
    throw new Error(breakers.reason);
  }

  db.updateNodeStatus(nodeId, "running");
  db.insertRun(nodeId, "running");

  // Increment LLM call counter
  db.incrementJobLLMCalls(node.jobId);

  try {
    const worker = workerRegistry.get(node.assignedAgent);

    // DRY RUN: log but don't execute
    if (job.dryRun) {
      const mockResult = generateMockResult(node);
      db.storeArtifacts(nodeId, mockResult.artifacts);
      db.updateNodeOutput(nodeId, mockResult.output);
      db.updateNodeStatus(nodeId, "completed");
      db.completeRun(nodeId, "completed", 0);
      return;
    }

    const result = await worker.execute(node);

    if (node.requiresApproval) {
      db.storePendingApproval(nodeId, result);
      db.updateNodeStatus(nodeId, "waiting_approval");
      notifyUserForApproval(nodeId, result);
      return;
    }

    db.storeArtifacts(nodeId, result.artifacts);
    db.updateNodeOutput(nodeId, result.output);
    db.updateNodeStatus(nodeId, "completed");
    db.completeRun(nodeId, "completed", result.costTokens);
  } catch (error) {
    handleNodeFailure(nodeId, error);
  }
}
```

---

## 16. FAILURE HANDLING

If a node fails:
1. Log the error
2. Increment retry count
3. Increment job-level retry counter
4. Check circuit breakers (total retries)
5. Retry if below `maxRetries` AND circuit breaker not tripped
6. Otherwise mark `failed`

```typescript
function handleNodeFailure(nodeId: string, error: Error) {
  const node = db.getNode(nodeId);

  ledger.log({
    agent: node.assignedAgent,
    action: "node_failure",
    tool: node.type,
    params: node.input,
    result: { error: error.message },
    status: "failed",
    costTokens: 0,
  });

  if (node.retryCount < node.maxRetries) {
    db.incrementRetryCount(nodeId);
    db.incrementJobRetries(node.jobId);

    // Check if total job retries exceeded
    const job = db.getJob(node.jobId);
    const breakers = checkCircuitBreakers(job, node.tokenBudget);
    if (!breakers.ok) {
      db.updateNodeStatus(nodeId, "failed");
      db.updateJobStatus(node.jobId, "failed");
      return;
    }

    db.updateNodeStatus(nodeId, "pending");
  } else {
    db.updateNodeStatus(nodeId, "failed");
    db.completeRun(nodeId, "failed", 0);
  }
}
```

---

## 17. APPROVAL SYSTEM

Nodes requiring approval must not complete immediately. Instead they:

1. Execute draft / preparation work
2. Store the proposed action
3. Wait for user approval via Telegram
4. Continue only after approval

**Examples:**
- Draft email → approval → send email
- Draft calendar event → approval → create event
- Generate tweets → approval → post

**Approval table schema:**
```typescript
interface PendingApproval {
  id: string;
  nodeId: string;
  actionType: string;
  preview: string;
  payload: Record<string, any>;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
}
```

---

## 18. APPROVAL FLOW

### If approved
- Execute the final external action
- Mark node `completed`

### If rejected
- Mark node `cancelled` or `failed`
- Optionally route to a revision node

---

## 19. ARTIFACT MODEL

```typescript
interface Artifact {
  id: string;
  jobId: string;
  nodeId: string;
  type: string;
  title: string;
  path?: string;
  content?: string;
  metadata?: Record<string, any>;
  createdAt: number;
}
```

**Artifact type examples:**
- `email_summary`
- `draft_reply`
- `research_report`

---

## 20. WORKER INTERFACE

```typescript
interface WorkerResult {
  output: Record<string, any>;
  artifacts: Artifact[];
  costTokens: number;
}

interface Worker {
  name: string;
  execute(node: TaskNode): Promise<WorkerResult>;
}
```

---

## 21. WORKER ROUTING

| Node Type | Assigned Worker |
|-----------|----------------|
| `research.*` | ResearchAgent |
| `gmail.*` / `calendar.*` / `drive.*` | WorkspaceAgent |
| `publish.*` / `post.*` | PublisherAgent |
| `aggregate` | **AggregatorAgent** (see below) |

v2 worker routing (`browser.*` → BrowserAgent, `build.*` → BuilderAgent, `review.*` → ReviewerAgent) is defined in `WORKER_AGENTS.md` Appendix A1. Do not implement for MVP.

### AggregatorAgent — why it exists

The OperatorAgent is the orchestrator. It routes messages, selects templates, monitors execution, and communicates with the user. **It does not execute graph nodes.**

However, most template graphs end with an `aggregate` step that formats upstream artifacts into a user-facing summary. This is a graph node and must be executed by a registered worker — not by the orchestrator.

The **AggregatorAgent** is a minimal, LLM-only worker with one job: read upstream artifacts and produce a formatted summary. It uses the `fast` tier model and has no tool permissions. It is registered in the WorkerRegistry like any other worker.

```typescript
const AggregatorAgent: WorkerAgent = {
  name: "AggregatorAgent",
  supportedNodeTypes: ["aggregate"],
  async execute(node: TaskNode, ctx: ToolContext): Promise<WorkerResult> {
    const upstreamArtifacts = await resolveUpstreamArtifacts(node, db);
    const summary = await llm.complete({
      model: node.model,  // always "fast" tier
      messages: [{
        role: "system",
        content: "Summarize the completed work into a concise, readable message for the user. No preamble."
      }, {
        role: "user",
        content: JSON.stringify(upstreamArtifacts.map(a => ({ type: a.type, title: a.title, content: a.content })))
      }]
    });
    return {
      output: { summary: summary.text },
      artifacts: [{ type: "job_summary", title: "Job Summary", content: summary.text }],
      costTokens: summary.usage.total_tokens,
      status: "completed"
    };
  }
};
```

This keeps the boundary clean: the OperatorAgent orchestrates, the AggregatorAgent executes aggregation nodes, and neither one crosses into the other's territory.

---

## 22. BUDGET ENFORCEMENT

Every node execution must check:
- Remaining job token budget
- Remaining node token budget
- Job time budget
- Hard circuit breakers

```typescript
function canRunNode(job: Job, node: TaskNode): boolean {
  if (job.budgetTokens <= 0) return false;
  if (node.tokenBudget <= 0) return false;
  const breakers = checkCircuitBreakers(job, node.tokenBudget);
  if (!breakers.ok) return false;
  return true;
}
```

After every node, subtract actual token usage from both job and node budgets and log to ledger.

---

## 23. MEMORY INTEGRATION

Before execution, a node may retrieve relevant memory.

**Retrieval rules:**
- Retrieve max 3 items via tag match + FTS5 (see `CLAWSPEC.md` Section 15)
- Total injected memory must not exceed **500 tokens**. If 3 items exceed this, truncate to 2 or 1.
- Never dump full memory into context

```typescript
const memoryItems = memory.retrieve(node.description, 3);
const trimmed = trimToTokenBudget(memoryItems, 500);
```

**Ingestion rules (after node completion):**
- The executor may store an episodic memory from the node's output — but only if the output is a meaningful outcome (e.g., "drafted 3 emails"), not raw data.
- Max 300 tokens per memory item. Longer outputs must be summarized before storage.
- Duplicate detection via FTS5 prevents redundant entries.
- See `CLAWSPEC.md` Section 15 for full ingestion function and pruning rules.

Worker prompt should include:
- Current node goal
- Relevant upstream artifacts
- Retrieved memory snippets (max 3, max 500 tokens total)
- Tool permissions

---

## 24. GRAPH VALIDATION

Before execution, validate:

1. All node IDs are unique
2. All dependency references are valid
3. No cycles exist
4. All agents are known
5. All models are valid
6. Budgets are set
7. Approval nodes are marked correctly
8. Total nodes <= hardLimits.maxNodesPerJob

```typescript
function validateDAG(nodes: TaskNode[]): boolean {
  // topological sort or DFS cycle detection
  // also check node count against hard limits
}
```

---

## 25. TOPOLOGICAL SORT

Implement a topological sort utility for validation and debugging.

```typescript
function topologicalSort(nodes: TaskNode[]): string[] {
  // Kahn's algorithm
}
```

---

## 26. CONCURRENCY STRATEGY

**Default:** max 4 parallel workers per job

**Rules:**
- Do not exceed global worker limit
- Do not run nodes whose dependencies are incomplete
- Avoid duplicate execution of the same node

**Future improvement:** separate concurrency pools per worker type

---

## 27. AGGREGATION STEP

When the graph completes, aggregate outputs into a final user response.

Aggregation should:
- Summarize completed actions
- Highlight generated artifacts
- List pending approvals or failures
- Keep response concise and readable
- Use the `fast` tier model

**Example output:**
```text
Done:
- 8 unread emails analyzed
- 5 replies drafted
- 2 follow-up meetings prepared for approval
```

---

## 28. CHANNEL EVENT INTEGRATION

```text
Channel message (any platform)
→ Channel Adapter
→ Message Router
→ (if complex) Template Selector (or Bounded Agentic Fallback)
→ Graph stored in SQLite
→ Executor starts
→ Progress updates sent back via originating channel adapter
```

Approval buttons/interactions are channel-specific but map to the same approval resolution system. See `CHANNEL_ADAPTERS.md` for per-channel approval UX.

---

## 29. CRON AND HEARTBEAT EVENT INTEGRATION

Cron jobs and heartbeat triggers are first-class events and use template graphs.

**Cron example:**
```text
Every day at 9am
→ create job from Template G (research to posts)
→ research topic
→ draft 4 tweets
→ wait for approval
```

**Heartbeat example:**
```text
Every 30 minutes
→ single fast-tier LLM call checks HEARTBEAT.md conditions
→ if action needed: create job from matched template
→ normal execution with all safety rails
→ notify user via default channel
```

Heartbeat is NOT a cron job — it's a lightweight classification call that decides whether to create a job. See `CLAWSPEC.md` Section 8a.

---

## 30. RESUMABILITY

If ClawLite crashes, on restart it must:

- Load all jobs with status `running`, `queued`, or `waiting_approval`
- Requeue safe nodes if needed
- Preserve completed artifacts
- **Never lose ledger entries**

This is critical for production reliability.

---

## 30a. CHECKPOINT / CRASH CONSISTENCY RULES

Resumability only works if the database is always in a consistent state. These rules are mandatory:

**Rule 1: Every node status transition is a SQLite transaction.**

```typescript
function transitionNodeStatus(nodeId: string, newStatus: NodeStatus, output?: any) {
  db.transaction(() => {
    db.updateNodeStatus(nodeId, newStatus);
    if (output) db.updateNodeOutput(nodeId, output);
    db.updateNodeUpdatedAt(nodeId, Date.now());
  })();
}
```

Never update node status and output in separate statements. A crash between two separate writes leaves the DB in an inconsistent state.

**Rule 2: Ledger entries are written before the action, not after.**

```typescript
// Write intent first
db.insertLedgerEntry({ ...entry, status: "started" });
// Then execute
const result = await tool.handler(params, ctx);
// Then update
db.updateLedgerEntry(entry.id, { status: "success", result });
```

This ensures crashed mid-execution actions appear in the ledger as `started` (not silently lost), so they can be inspected on restart.

**Rule 3: On restart, nodes in `running` status are reset to `pending`.**

A node with status `running` at startup means ClawLite crashed while it was executing. Reset it:

```typescript
function recoverCrashedJobs() {
  // Nodes that were mid-execution when crash happened
  db.resetRunningNodesToPending();
  // Re-attach event listeners for in-progress jobs
  const activeJobs = db.getJobsByStatus(["running", "waiting_approval"]);
  for (const job of activeJobs) {
    executeJob(job.id);
  }
}
```

---

## 31. MINIMUM CODE MODULES

```text
```text
/cli/setup.ts                   — onboarding CLI (clawlite setup) with channel selection
/cli/validateConfig.ts          — config validation
/llm/provider.ts                — provider-agnostic LLM abstraction
/llm/resolveModel.ts            — tier → provider model resolution
/planner/templates.ts           — template definitions
/planner/templateSelector.ts    — match message to template
/planner/slotExtractor.ts       — extract slots from user message
/planner/buildTaskGraph.ts      — instantiate template into graph
/planner/agenticFallback.ts     — bounded agentic plan generation + validation
/executor/executeJob.ts
/executor/runNode.ts
/executor/circuitBreakers.ts    — hard limit checks
/executor/graphValidation.ts
/executor/topologicalSort.ts
/workers/WorkspaceAgent.ts
/workers/ResearchAgent.ts
/workers/PublisherAgent.ts
/workers/AggregatorAgent.ts
/ledger/logAction.ts
/memory/retrieveMemory.ts
/memory/storeMemory.ts
/session/sessionManager.ts      — conversational history + compaction
/channels/adapters/*.ts         — per-channel adapter implementations
/channels/registry.ts           — channel registry
/http/server.ts                 — Fastify (webhooks, artifacts, status)
/heartbeat/heartbeat.ts         — proactive condition checker
/db/schema.ts
/db/jobs.ts
/db/nodes.ts
/db/runs.ts
/db/artifacts.ts
/db/approvals.ts
/db/sessions.ts                 — conversational session storage
```

---

## 32. MVP GRAPH TEMPLATES

The 8 MVP templates (A through H) are fully defined in Section 7 above, including node types, agent assignments, model tiers, and dependency chains. Do not duplicate them here — Section 7 is the single source of truth for template definitions.

---

## 33. CODING STYLE REQUIREMENTS

- TypeScript strict mode
- Small, single-responsibility modules
- Clear interfaces with explicit typing
- No giant files
- SQLite transactions where needed
- Structured logging
- Graceful error handling

---

## 34. IMPORTANT ARCHITECTURAL RULES

> **Rule 1: Do NOT implement an infinite autonomous thought loop.**

ClawLite must always operate as:

```text
event → route → select template → execute graph → sleep
```

This is mandatory.

> **Rule 2: Template graphs for MVP. Freeform planning is v2.**

> **Rule 3: Circuit breakers are checked before every node dispatch and every LLM call.**

> **Rule 4: Every node has an explicit model assignment. No expensive defaults.**

---

## 35. FINAL IMPLEMENTATION GOAL

The Task Graph Engine must make ClawLite feel like:

- A conversational AI operator
- Capable of complex multi-step work
- Capable of parallel task execution
- Safe and fully auditable
- **Cheap when idle** (lightweight chat path burns minimal tokens)
- **Cheap when working** (model tiering ensures the cheapest model does each job)
- Easy to extend with new templates, tools, and workers

---

*Next recommended spec: **`TOOL_SDK.md`** — defines exactly how to build the plugin/tool system so new capabilities can be added to ClawLite without rewriting the core.*

*The six core spec files are:*
- *`CLAWSPEC.md` — system overview, router, tiering, circuit breakers, heartbeat, sessions, HTTP server*
- *`TASKGRAPH_ENGINE.md` — this file, template graphs, DAG executor, bounded agentic fallback, hard limits*
- *`CHANNEL_ADAPTERS.md` — multi-channel abstraction, per-channel implementations*
- *`TOOL_SDK.md` — tool/plugin architecture, dry run support, hot-loading*
- *`WORKER_AGENTS.md` — MVP 4 agents, model-aware execution, agent profiles*

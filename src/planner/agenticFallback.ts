import { complete } from '../llm/provider.js';
import { getConfig } from '../core/config.js';
import { createJob } from '../db/jobs.js';
import { createNodes } from '../db/nodes.js';
import { validateDAG } from '../executor/graphValidation.js';

export interface AgenticFallbackParams {
  message: string;
  triggerType: string;
  channel: string;
  chatId: string;
  dryRun?: boolean;
}

/**
 * Bounded agentic plan generation:
 * 1. LLM generates plan JSON
 * 2. Validate as DAG
 * 3. Create job + nodes with tighter limits
 */
export async function handleAgenticFallback(
  params: AgenticFallbackParams,
): Promise<{ jobId: string; nodeIds: string[] }> {
  const config = getConfig();
  const limits = config.hardLimits;

  // 1. Generate plan
  const planResponse = await complete({
    model: 'balanced',
    format: 'json',
    messages: [
      {
        role: 'system',
        content: `You are a task planner. Generate a JSON array of steps for this request.
Each step must have: id (unique string), type (known tool/node type), title (string), description (string), assignedAgent (string: "WorkspaceAgent"|"ResearchAgent"|"PublisherAgent"|"AggregatorAgent"), model ("fast"|"balanced"), dependencies (array of step ids), requiresApproval (boolean).
Constraints: max ${limits.agenticMaxNodes} steps.
The last step should always be type "aggregate" with AggregatorAgent.
Response: { "steps": [...] }`,
      },
      { role: 'user', content: params.message },
    ],
  });

  const parsed = planResponse.parsed as { steps?: unknown[] } | undefined;
  if (!parsed?.steps || !Array.isArray(parsed.steps)) {
    throw new Error('Agentic fallback: LLM did not return a valid plan');
  }

  const steps = parsed.steps as Array<{
    id: string;
    type: string;
    title: string;
    description: string;
    assignedAgent: string;
    model: string;
    dependencies: string[];
    requiresApproval: boolean;
  }>;

  // 2. Validate constraints
  if (steps.length > limits.agenticMaxNodes) {
    throw new Error(`Agentic plan exceeds max nodes: ${steps.length} > ${limits.agenticMaxNodes}`);
  }

  if (steps.length === 0) {
    throw new Error('Agentic plan is empty');
  }

  // 3. Create job with tighter limits
  const job = createJob({
    goal: params.message,
    triggerType: params.triggerType,
    channel: params.channel,
    chatId: params.chatId,
    jobType: 'agentic',
    dryRun: params.dryRun ?? false,
    budgetTokens: Math.min(limits.agenticMaxTokenBudget, config.budgets.perJobTokens),
  });

  // 4. Create nodes
  const nodes = steps.map(step => ({
    jobId: job.id,
    id: `${job.id}_${step.id}`,
    type: step.type,
    title: step.title,
    description: step.description ?? '',
    assignedAgent: step.assignedAgent,
    model: step.model as 'fast' | 'balanced' | 'strong',
    dependencies: step.dependencies.map(d => `${job.id}_${d}`),
    maxRetries: 1, // tighter retry budget
    tokenBudget: Math.floor(limits.agenticMaxTokenBudget / steps.length),
    requiresApproval: step.requiresApproval,
  }));

  const created = createNodes(nodes);

  // 5. Validate DAG
  const validation = validateDAG(created);
  if (!validation.valid) {
    throw new Error(`Agentic plan validation failed: ${validation.errors.join(', ')}`);
  }

  return { jobId: job.id, nodeIds: created.map(n => n.id) };
}

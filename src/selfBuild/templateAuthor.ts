import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getClawliteHome } from '../db/connection.js';
import { complete } from '../llm/provider.js';
import { registerTemplate, type GraphTemplate } from '../planner/templates.js';
import { validateDAG } from '../executor/graphValidation.js';
import { logger } from '../core/logger.js';

export interface AuthorTemplateRequest {
  name: string;
  description: string;
  slashCommand?: string;
  steps: string;
}

export interface AuthorTemplateResult {
  template: GraphTemplate;
  errors: string[];
  valid: boolean;
}

/**
 * Generate a new template using balanced-tier LLM, then validate it.
 */
export async function authorTemplate(request: AuthorTemplateRequest): Promise<AuthorTemplateResult> {
  const result = await complete({
    model: 'balanced',
    messages: [
      {
        role: 'system',
        content: 'You are a ClawLite template author. Generate a valid template JSON. Only output JSON, no markdown.',
      },
      {
        role: 'user',
        content: buildTemplatePrompt(request),
      },
    ],
    format: 'json',
  });

  const template = result.parsed as GraphTemplate;

  // Ensure required fields
  if (!template.id) template.id = request.name.toLowerCase().replace(/\s+/g, '_');
  if (!template.name) template.name = request.name;
  if (!template.description) template.description = request.description;

  // Validate the DAG structure
  const errors = validateTemplateStructure(template);

  return { template, errors, valid: errors.length === 0 };
}

/**
 * Save an approved template to disk and register it.
 */
export function saveApprovedTemplate(template: GraphTemplate): string {
  const dir = join(getClawliteHome(), 'templates');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const filePath = join(dir, `${template.id}.json`);
  writeFileSync(filePath, JSON.stringify(template, null, 2));

  registerTemplate(template);
  logger.info('Template saved and registered', { id: template.id });
  return filePath;
}

/**
 * Promote an agentic plan result to a reusable template.
 */
export function promoteAgenticToTemplate(
  plan: { nodes: any[]; description: string },
  id: string,
  name: string,
  slashCommand?: string,
): GraphTemplate {
  const template: GraphTemplate = {
    id,
    name,
    description: plan.description,
    slashCommand,
    slots: [],
    nodes: plan.nodes.map(n => ({
      id: n.id,
      type: n.type,
      title: n.title ?? n.id,
      description: n.description ?? '',
      assignedAgent: n.assignedAgent ?? n.agent ?? 'WorkspaceAgent',
      model: n.model ?? 'fast',
      dependencies: n.dependencies ?? [],
      input: n.input ?? {},
      toolPermissions: n.toolPermissions ?? [],
      requiresApproval: n.requiresApproval ?? false,
    })),
  };

  return template;
}

function validateTemplateStructure(template: GraphTemplate): string[] {
  const errors: string[] = [];

  if (!template.nodes || !Array.isArray(template.nodes) || template.nodes.length === 0) {
    errors.push('Template must have at least one node');
    return errors;
  }

  // Check for unique IDs
  const ids = new Set<string>();
  for (const node of template.nodes) {
    if (ids.has(node.id)) {
      errors.push(`Duplicate node ID: ${node.id}`);
    }
    ids.add(node.id);
  }

  // Check dependencies reference valid nodes
  for (const node of template.nodes) {
    for (const dep of node.dependencies) {
      if (!ids.has(dep)) {
        errors.push(`Node ${node.id} depends on unknown node: ${dep}`);
      }
    }
  }

  // Check valid model tiers
  const validModels = ['fast', 'balanced', 'strong'];
  for (const node of template.nodes) {
    if (!validModels.includes(node.model)) {
      errors.push(`Node ${node.id} has invalid model: ${node.model}`);
    }
  }

  // Node count limit
  if (template.nodes.length > 20) {
    errors.push(`Too many nodes: ${template.nodes.length} (max 20)`);
  }

  return errors;
}

function buildTemplatePrompt(request: AuthorTemplateRequest): string {
  return `Create a ClawLite template definition:

Name: ${request.name}
Description: ${request.description}
${request.slashCommand ? `Slash command: ${request.slashCommand}` : ''}

User-described steps:
${request.steps}

Generate a JSON object with:
{
  "id": "snake_case_id",
  "name": "Human Name",
  "description": "...",
  ${request.slashCommand ? `"slashCommand": "${request.slashCommand}",` : ''}
  "slots": [{ "name": "...", "description": "...", "required": true/false }],
  "nodes": [{
    "id": "node_id",
    "type": "agent_type.action",
    "title": "Step title",
    "description": "What this step does",
    "assignedAgent": "WorkspaceAgent|ResearchAgent|PublisherAgent|AggregatorAgent",
    "model": "fast|balanced|strong",
    "dependencies": [],
    "input": {},
    "toolPermissions": [],
    "requiresApproval": false
  }]
}

Use "fast" model by default, "balanced" for analysis/reasoning, "strong" only for complex generation.
Set requiresApproval: true for any node that sends, publishes, or creates external content.`;
}

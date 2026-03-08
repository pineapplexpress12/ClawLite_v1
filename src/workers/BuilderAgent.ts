import type { WorkerAgent } from './types.js';
import type { ToolContext, WorkerResult } from '../tools/sdk/types.js';
import type { NodeRow } from '../db/nodes.js';
import { complete } from '../llm/provider.js';
import { analyzeToolSecurity } from '../tools/sdk/securityAnalysis.js';
import { validateDAG } from '../executor/graphValidation.js';
import { logger } from '../core/logger.js';

/**
 * BuilderAgent — generates tools, templates, and sub-agent configurations.
 * ALL outputs require user approval.
 * Handles: build.*
 */
export const BuilderAgent: WorkerAgent = {
  name: 'BuilderAgent',
  supportedNodeTypes: ['build.*'],

  async execute(node: NodeRow, ctx: ToolContext): Promise<WorkerResult> {
    const input = JSON.parse(node.input_data);

    switch (node.type) {
      case 'build.generate_tool':
        return generateTool(node, input, ctx);
      case 'build.generate_template':
        return generateTemplate(node, input, ctx);
      case 'build.generate_subagent':
        return generateSubAgent(node, input, ctx);
      default:
        return { status: 'failed', costTokens: 0, error: `Unknown build type: ${node.type}` };
    }
  },
};

async function generateTool(
  node: NodeRow,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<WorkerResult> {
  const toolName = (input.toolName as string) ?? 'custom_tool';
  const apiSpec = (input.apiSpec as string) ?? (input.apiDescription as string) ?? '';

  const response = await complete({
    model: node.model as 'fast' | 'balanced' | 'strong',
    messages: [
      {
        role: 'system',
        content: `You are a tool generator for ClawLite. Generate a TypeScript tool file that follows the ToolDefinition interface.
Requirements:
- Import { z } from "zod" and { ToolDefinition } from "../sdk/types"
- Define a Zod schema for all parameters
- Declare permissions for each action
- Set requiresApproval: true for any create/delete/send/publish/deploy actions
- Include a mockHandler for dry run support
- Use ctx.secrets.get() for API keys — NEVER hardcode credentials
- Return structured JSON from the handler
- Handle errors gracefully with try/catch

Tool name: ${toolName}
API specification: ${apiSpec}`,
      },
      { role: 'user', content: `Generate the tool file for: ${toolName}` },
    ],
  });

  const code = response.text;

  // Run security analysis
  const security = analyzeToolSecurity(code, `${toolName}.tool.ts`, []);

  const { artifactId } = await ctx.artifacts.writeText({
    type: 'generated_tool',
    title: `Tool: ${toolName}`,
    content: code,
  });

  const hasCritical = security.criticalIssues.length > 0;

  return {
    status: hasCritical ? 'failed' : 'waiting_approval',
    output: {
      toolName,
      code,
      securityScore: security.score,
      criticalIssues: security.criticalIssues,
      warnings: security.warnings,
      requiresUserApproval: true,
    },
    artifactIds: [artifactId],
    costTokens: response.usage.total_tokens,
    error: hasCritical
      ? `Security analysis failed: ${security.criticalIssues.map(i => i.code).join(', ')}`
      : undefined,
  };
}

async function generateTemplate(
  node: NodeRow,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<WorkerResult> {
  const templateName = (input.templateName as string) ?? 'custom_template';

  const response = await complete({
    model: node.model as 'fast' | 'balanced' | 'strong',
    format: 'json',
    messages: [
      {
        role: 'system',
        content: `You are a template generator for ClawLite. Generate a JSON template for a task graph workflow.
Requirements:
- Each node: id (string), type (string), title (string), description (string), assignedAgent (WorkspaceAgent|ResearchAgent|PublisherAgent|AggregatorAgent), model (fast|balanced|strong), dependencies (string[]), requiresApproval (boolean)
- Valid DAG (no cycles)
- Use cheapest appropriate model tier
- requiresApproval: true for external/irreversible actions
- Max 15 nodes
Return: { "id": "${templateName}", "name": "...", "description": "...", "slots": [...], "nodes": [...] }`,
      },
      { role: 'user', content: (input.description as string) ?? `Generate template: ${templateName}` },
    ],
  });

  const { artifactId } = await ctx.artifacts.writeText({
    type: 'generated_template',
    title: `Template: ${templateName}`,
    content: response.text,
  });

  return {
    status: 'waiting_approval',
    output: {
      templateName,
      template: response.parsed,
      requiresUserApproval: true,
    },
    artifactIds: [artifactId],
    costTokens: response.usage.total_tokens,
  };
}

async function generateSubAgent(
  node: NodeRow,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<WorkerResult> {
  const profile = {
    name: (input.name as string) ?? 'custom_agent',
    description: (input.description as string) ?? '',
    persona: (input.persona as string) ?? '',
    tools: (input.tools as string[]) ?? [],
    templates: (input.templates as string[]) ?? [],
    defaultTier: (input.defaultTier as string) ?? 'balanced',
    budgetTokensDaily: (input.budgetTokensDaily as number) ?? 50000,
  };

  const { artifactId } = await ctx.artifacts.writeText({
    type: 'generated_subagent',
    title: `Sub-agent: ${profile.name}`,
    content: JSON.stringify(profile, null, 2),
  });

  return {
    status: 'waiting_approval',
    output: { profile, requiresUserApproval: true },
    artifactIds: [artifactId],
    costTokens: 0,
  };
}

import type { WorkerAgent } from './types.js';
import type { ToolContext, WorkerResult } from '../tools/sdk/types.js';
import type { NodeRow } from '../db/nodes.js';
import { complete } from '../llm/provider.js';
import { getArtifactsByNodeIds } from '../db/artifacts.js';

/**
 * AggregatorAgent — formats upstream artifacts into a user-facing summary.
 * Handles: aggregate
 */
export const AggregatorAgent: WorkerAgent = {
  name: 'AggregatorAgent',
  supportedNodeTypes: ['aggregate'],

  async execute(node: NodeRow, ctx: ToolContext): Promise<WorkerResult> {
    const deps: string[] = JSON.parse(node.dependencies);
    const upstreamArtifacts = getArtifactsByNodeIds(deps);

    const sections = upstreamArtifacts.map(a => {
      const header = a.title || a.type;
      const body = a.content ?? '[no content]';
      return `## ${header}\n${body}`;
    });

    const combinedContent = sections.join('\n\n');

    if (!combinedContent.trim()) {
      const { artifactId } = await ctx.artifacts.writeText({
        type: 'summary',
        title: node.title,
        content: 'No upstream data to aggregate.',
      });
      return {
        status: 'completed',
        output: { summary: 'No upstream data to aggregate.' },
        artifactIds: [artifactId],
        costTokens: 0,
      };
    }

    const response = await complete({
      model: node.model as 'fast' | 'balanced' | 'strong',
      messages: [
        {
          role: 'system',
          content: 'You are a formatting assistant. Synthesize the following sections into a clear, user-friendly markdown summary. Be concise and highlight the most important information.',
        },
        { role: 'user', content: combinedContent },
      ],
    });

    const { artifactId } = await ctx.artifacts.writeText({
      type: 'summary',
      title: node.title,
      content: response.text,
    });

    return {
      status: 'completed',
      output: { summary: response.text, artifactId },
      artifactIds: [artifactId],
      costTokens: response.usage.total_tokens,
    };
  },
};

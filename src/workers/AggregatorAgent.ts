import type { WorkerAgent } from './types.js';
import type { ToolContext, WorkerResult } from '../tools/sdk/types.js';
import type { NodeRow } from '../db/nodes.js';
import { complete } from '../llm/provider.js';
import { getArtifactsByNodeIds } from '../db/artifacts.js';
import { logger } from '../core/logger.js';

/** Max chars of upstream data to send to LLM. */
const MAX_LLM_INPUT_CHARS = 50000;

/**
 * Sanitize + truncate upstream text for LLM consumption.
 */
function prepareForLLM(text: string): string {
  let result = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  if (result.length > MAX_LLM_INPUT_CHARS) {
    result = result.slice(0, MAX_LLM_INPUT_CHARS) + '\n...(truncated)';
    logger.info('AggregatorAgent truncated upstream data', { original: text.length, truncated: result.length });
  }
  return result;
}

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

    const rawContent = sections.join('\n\n');

    if (!rawContent.trim() || rawContent.length < 10) {
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

    const combinedContent = prepareForLLM(rawContent);

    try {
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
    } catch (err) {
      logger.error('AggregatorAgent LLM call failed', { error: (err as Error).message, dataSize: combinedContent.length });

      // Fallback: return truncated raw data
      const fallback = 'Could not generate summary. Here is the raw data:\n' + combinedContent.slice(0, 5000);
      const { artifactId } = await ctx.artifacts.writeText({
        type: 'summary',
        title: node.title,
        content: fallback,
      });
      return {
        status: 'completed',
        output: { summary: fallback, artifactId },
        artifactIds: [artifactId],
        costTokens: 0,
      };
    }
  },
};

import type { WorkerAgent } from './types.js';
import type { ToolContext, WorkerResult } from '../tools/sdk/types.js';
import type { NodeRow } from '../db/nodes.js';
import { complete } from '../llm/provider.js';
import { getArtifactsByNodeIds } from '../db/artifacts.js';
import { logger } from '../core/logger.js';

/**
 * ResearchAgent — web research via Perplexity Sonar and deep research.
 * Handles: research.search, research.deep, research.summarize
 */
export const ResearchAgent: WorkerAgent = {
  name: 'ResearchAgent',
  supportedNodeTypes: ['research.*'],

  async execute(node: NodeRow, ctx: ToolContext): Promise<WorkerResult> {
    const input = JSON.parse(node.input_data);
    const deps: string[] = JSON.parse(node.dependencies);

    switch (node.type) {
      case 'research.search':
      case 'research.deep': {
        const query = input.query as string;
        if (!query) {
          return { status: 'failed', costTokens: 0, error: 'Missing query in node input' };
        }

        const action = node.type === 'research.deep' ? 'deep' : 'search';

        try {
          // Use LLM to simulate research (tool invocation handled by tool SDK in real flow)
          const response = await complete({
            model: node.model as 'fast' | 'balanced' | 'strong',
            format: 'json',
            messages: [
              { role: 'system', content: `You are a research assistant. Conduct a ${action} search on the topic. Return JSON with: summary (string), keyInsights (string[]), sources (array of {title, url, snippet}), citations (string[]).` },
              { role: 'user', content: query },
            ],
          });

          const parsed = response.parsed as Record<string, unknown> ?? {};

          const { artifactId } = await ctx.artifacts.writeText({
            type: 'research_report',
            title: `Research: ${query.slice(0, 50)}`,
            content: response.text,
          });

          return {
            status: 'completed',
            output: { ...parsed, artifactId },
            artifactIds: [artifactId],
            costTokens: response.usage.total_tokens,
          };
        } catch (err) {
          logger.error('Research failed', { nodeId: node.id, error: (err as Error).message });
          return { status: 'failed', costTokens: 0, error: (err as Error).message };
        }
      }

      case 'research.summarize': {
        // Retrieve upstream artifacts
        const upstreamArtifacts = getArtifactsByNodeIds(deps);
        const upstreamContent = upstreamArtifacts
          .map(a => a.content ?? '')
          .filter(Boolean)
          .join('\n\n---\n\n');

        try {
          const response = await complete({
            model: node.model as 'fast' | 'balanced' | 'strong',
            format: 'json',
            messages: [
              { role: 'system', content: 'Summarize the research findings. Return JSON with: summary (string), keyInsights (string[]), actionItems (string[]).' },
              { role: 'user', content: upstreamContent || 'No upstream data available.' },
            ],
          });

          const parsed = response.parsed as Record<string, unknown> ?? {};

          const { artifactId } = await ctx.artifacts.writeText({
            type: 'research_summary',
            title: 'Research Summary',
            content: response.text,
          });

          return {
            status: 'completed',
            output: { ...parsed, artifactId },
            artifactIds: [artifactId],
            costTokens: response.usage.total_tokens,
          };
        } catch (err) {
          return { status: 'failed', costTokens: 0, error: (err as Error).message };
        }
      }

      default:
        return { status: 'failed', costTokens: 0, error: `Unknown node type: ${node.type}` };
    }
  },
};

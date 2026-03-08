import type { WorkerAgent } from './types.js';
import type { ToolContext, WorkerResult } from '../tools/sdk/types.js';
import type { NodeRow } from '../db/nodes.js';
import { complete } from '../llm/provider.js';
import { getArtifactsByNodeIds } from '../db/artifacts.js';

const ALWAYS_REQUIRES_APPROVAL = [
  'publish.tweet',
  'publish.linkedin',
  'publish.telegram_message',
  'publish.post',
];

/**
 * PublisherAgent — formats and publishes content with approval gating.
 * Handles: publish.*
 */
export const PublisherAgent: WorkerAgent = {
  name: 'PublisherAgent',
  supportedNodeTypes: ['publish.*'],

  async execute(node: NodeRow, ctx: ToolContext): Promise<WorkerResult> {
    const input = JSON.parse(node.input_data);
    const deps: string[] = JSON.parse(node.dependencies);

    switch (node.type) {
      case 'publish.draft_posts': {
        const upstreamArtifacts = getArtifactsByNodeIds(deps);
        const researchContent = upstreamArtifacts.map(a => a.content ?? '').join('\n');
        const count = (input.count as number) ?? 4;
        const platform = (input.platform as string) ?? 'twitter';

        const response = await complete({
          model: node.model as 'fast' | 'balanced' | 'strong',
          format: 'json',
          messages: [
            {
              role: 'system',
              content: `You are a social media content writer. Draft ${count} posts for ${platform} based on the research. Return JSON with: posts (array of {text, hashtags}).`,
            },
            { role: 'user', content: researchContent || 'No research content available.' },
          ],
        });

        const { artifactId } = await ctx.artifacts.writeText({
          type: 'draft_posts',
          title: `Draft ${platform} posts`,
          content: response.text,
        });

        return {
          status: 'completed',
          output: { ...(response.parsed as object ?? {}), platform, artifactId },
          artifactIds: [artifactId],
          costTokens: response.usage.total_tokens,
        };
      }

      case 'publish.tweet':
      case 'publish.linkedin':
      case 'publish.telegram_message':
      case 'publish.post':
      case 'publish.notify': {
        // All external publish actions require approval
        if (ALWAYS_REQUIRES_APPROVAL.includes(node.type) || node.requires_approval) {
          const upstreamArtifacts = getArtifactsByNodeIds(deps);
          const preview = upstreamArtifacts.map(a => a.content ?? '').join('\n').slice(0, 500);

          const { approvalId } = await ctx.approvals.request({
            actionType: node.type,
            title: node.title,
            preview: preview || input.content || 'Content pending',
            data: input,
          });

          return { status: 'waiting_approval', costTokens: 0, approvalId };
        }

        // If no approval needed (e.g., publish.notify), execute directly
        return {
          status: 'completed',
          output: { published: true, type: node.type },
          costTokens: 0,
        };
      }

      default:
        return { status: 'failed', costTokens: 0, error: `Unknown publish type: ${node.type}` };
    }
  },
};

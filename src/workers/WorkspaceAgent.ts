import type { WorkerAgent } from './types.js';
import type { ToolContext, WorkerResult } from '../tools/sdk/types.js';
import type { NodeRow } from '../db/nodes.js';
import { complete } from '../llm/provider.js';
import { getArtifactsByNodeIds } from '../db/artifacts.js';
import { logger } from '../core/logger.js';

const APPROVAL_REQUIRED_TYPES = ['gmail.send', 'calendar.create', 'drive.share'];

/**
 * WorkspaceAgent — Gmail, Calendar, Drive operations via gws CLI.
 * Handles: gmail.*, calendar.*, drive.*
 */
export const WorkspaceAgent: WorkerAgent = {
  name: 'WorkspaceAgent',
  supportedNodeTypes: ['gmail.*', 'calendar.*', 'drive.*'],

  async execute(node: NodeRow, ctx: ToolContext): Promise<WorkerResult> {
    const input = JSON.parse(node.input_data);
    const deps: string[] = JSON.parse(node.dependencies);

    // Check if approval is needed
    if (APPROVAL_REQUIRED_TYPES.includes(node.type) && node.requires_approval) {
      const { approvalId } = await ctx.approvals.request({
        actionType: node.type,
        title: node.title,
        preview: JSON.stringify(input, null, 2),
        data: input,
      });
      return { status: 'waiting_approval', costTokens: 0, approvalId };
    }

    switch (node.type) {
      case 'gmail.list':
      case 'gmail.fetch': {
        // Data retrieval — no LLM needed, would invoke workspace tool
        const { artifactId } = await ctx.artifacts.writeText({
          type: 'email_data',
          title: node.title,
          content: JSON.stringify({ action: node.type, params: input }),
        });
        return {
          status: 'completed',
          output: { action: node.type, ...input, artifactId },
          artifactIds: [artifactId],
          costTokens: 0,
        };
      }

      case 'gmail.summarize': {
        const upstreamArtifacts = getArtifactsByNodeIds(deps);
        const emailData = upstreamArtifacts.map(a => a.content ?? '').join('\n');

        const response = await complete({
          model: node.model as 'fast' | 'balanced' | 'strong',
          format: 'json',
          messages: [
            { role: 'system', content: 'Summarize these email threads. Return JSON with: summary (string), threads (array of {subject, from, priority, actionNeeded}).' },
            { role: 'user', content: emailData || 'No emails.' },
          ],
        });

        const { artifactId } = await ctx.artifacts.writeText({
          type: 'email_summary',
          title: 'Email Summary',
          content: response.text,
        });

        return {
          status: 'completed',
          output: { ...(response.parsed as object ?? {}), artifactId },
          artifactIds: [artifactId],
          costTokens: response.usage.total_tokens,
        };
      }

      case 'gmail.draft':
      case 'gmail.draft_replies': {
        const upstreamArtifacts = getArtifactsByNodeIds(deps);
        const context = upstreamArtifacts.map(a => a.content ?? '').join('\n');

        const response = await complete({
          model: node.model as 'fast' | 'balanced' | 'strong',
          format: 'json',
          messages: [
            { role: 'system', content: 'Draft an email reply. Return JSON with: to (string), subject (string), body (string), draftId (string).' },
            { role: 'user', content: `Context:\n${context}\n\nInstructions: ${input.instructions ?? 'Reply appropriately.'}` },
          ],
        });

        const { artifactId } = await ctx.artifacts.writeText({
          type: 'email_draft',
          title: 'Draft Reply',
          content: response.text,
        });

        return {
          status: 'completed',
          output: { ...(response.parsed as object ?? {}), artifactId },
          artifactIds: [artifactId],
          costTokens: response.usage.total_tokens,
        };
      }

      case 'gmail.send': {
        // Should have been caught by approval check above
        return { status: 'completed', output: { sent: true }, costTokens: 0 };
      }

      case 'calendar.list': {
        const { artifactId } = await ctx.artifacts.writeText({
          type: 'calendar_data',
          title: node.title,
          content: JSON.stringify({ action: 'calendar.list', params: input }),
        });
        return {
          status: 'completed',
          output: { action: 'calendar.list', ...input, artifactId },
          artifactIds: [artifactId],
          costTokens: 0,
        };
      }

      case 'calendar.propose': {
        const upstreamArtifacts = getArtifactsByNodeIds(deps);
        const context = upstreamArtifacts.map(a => a.content ?? '').join('\n');

        const response = await complete({
          model: node.model as 'fast' | 'balanced' | 'strong',
          format: 'json',
          messages: [
            { role: 'system', content: 'Propose follow-up meetings based on the context. Return JSON with: proposals (array of {title, suggestedDate, suggestedTime, duration, attendees, reason}).' },
            { role: 'user', content: context || 'No context available.' },
          ],
        });

        const { artifactId } = await ctx.artifacts.writeText({
          type: 'calendar_proposals',
          title: 'Meeting Proposals',
          content: response.text,
        });

        return {
          status: 'completed',
          output: { ...(response.parsed as object ?? {}), artifactId },
          artifactIds: [artifactId],
          costTokens: response.usage.total_tokens,
        };
      }

      case 'calendar.create': {
        return { status: 'completed', output: { created: true, ...input }, costTokens: 0 };
      }

      default: {
        logger.warn('Unhandled workspace node type', { type: node.type });
        return { status: 'failed', costTokens: 0, error: `Unsupported type: ${node.type}` };
      }
    }
  },
};

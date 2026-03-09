import type { WorkerAgent } from './types.js';
import type { ToolContext, WorkerResult } from '../tools/sdk/types.js';
import type { NodeRow } from '../db/nodes.js';
import { complete } from '../llm/provider.js';
import { getArtifactsByNodeIds } from '../db/artifacts.js';
import { getTool } from '../tools/sdk/registry.js';
import { logger } from '../core/logger.js';

const APPROVAL_REQUIRED_TYPES = ['gmail.send', 'calendar.create', 'drive.share'];

export const WorkspaceAgent: WorkerAgent = {
  name: 'WorkspaceAgent',
  supportedNodeTypes: ['gmail.*', 'calendar.*', 'drive.*'],

  async execute(node: NodeRow, ctx: ToolContext): Promise<WorkerResult> {
    const input = JSON.parse(node.input_data);
    const deps: string[] = JSON.parse(node.dependencies);

    switch (node.type) {
      case 'gmail.list':
      case 'gmail.fetch': {
        const workspaceTool = getTool('workspace');
        if (!workspaceTool) throw new Error('Workspace tool not loaded');

        const listResult = await workspaceTool.handler(
          { action: 'gmail.list', params: { maxResults: 10, q: 'is:unread', userId: 'me', ...(input || {}) } },
          ctx,
        );

        if (listResult && typeof listResult === 'object' && (listResult as any).status === 'not_connected') {
          throw new Error('Google Workspace is not connected. Say "connect gws" to set it up.');
        }

        const listData = (listResult as any)?.data ?? listResult;
        let messageIds: string[] = [];
        if (Array.isArray(listData)) {
          for (const page of listData) {
            if (page.messages && Array.isArray(page.messages)) {
              messageIds.push(...page.messages.map((m: any) => m.id));
            } else if (page.id) {
              messageIds.push(page.id);
            }
          }
        }
        messageIds = messageIds.slice(0, 10);

        const emails: any[] = [];
        for (const msgId of messageIds) {
          try {
            const msgResult = await workspaceTool.handler(
              { action: 'gmail.get', params: { id: msgId, userId: 'me', format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] } },
              ctx,
            );
            const msgArr = (msgResult as any)?.data;
            if (Array.isArray(msgArr) && msgArr.length > 0) {
              const msg = msgArr[0];
              const headers = msg.payload?.headers ?? [];
              const hdr = (name: string) => headers.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
              emails.push({
                id: msg.id,
                threadId: msg.threadId,
                from: hdr('From'),
                to: hdr('To'),
                subject: hdr('Subject'),
                date: hdr('Date'),
                snippet: msg.snippet ?? '',
                labels: msg.labelIds ?? [],
              });
            }
          } catch (err) {
            logger.warn('Failed to fetch message', { msgId, error: (err as Error).message });
          }
        }

        const content = JSON.stringify(emails, null, 2);
        const { artifactId } = await ctx.artifacts.writeText({
          type: 'email_data',
          title: node.title,
          content,
        });

        return {
          status: 'completed',
          output: { data: emails, count: emails.length, artifactId },
          artifactIds: [artifactId],
          costTokens: 0,
        };
      }

      case 'gmail.summarize': {
        const upstreamArtifacts = getArtifactsByNodeIds(deps);
        let emailData = upstreamArtifacts.map(a => a.content ?? '').join('\n');
        emailData = emailData.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
        if (emailData.length > 40000) emailData = emailData.slice(0, 40000) + '\n...(truncated)';

        if (!emailData || emailData.length < 10) {
          const { artifactId } = await ctx.artifacts.writeText({
            type: 'email_summary',
            title: 'Inbox Briefing',
            content: 'Your inbox is clear — no unread emails.',
          });
          return { status: 'completed', output: { summary: 'Inbox clear', artifactId }, artifactIds: [artifactId], costTokens: 0 };
        }

        try {
          const response = await complete({
            model: (node.model as 'fast' | 'balanced' | 'strong') || 'balanced',
            messages: [
              {
                role: 'system',
                content: `You are an executive assistant analyzing your boss's inbox. Produce a concise briefing:

🔴 **Urgent** — time-sensitive, needs immediate action
📧 **Needs Reply** — someone is waiting for a response
📋 **FYI** — informational, no action needed
🗑️ **Skip** — promotions, newsletters, automated notifications

Start with "You have X unread emails." Under each category, write 1-2 sentences per email with who, what, and suggested action. Keep total under 300 words. Do NOT output JSON.`,
              },
              { role: 'user', content: emailData },
            ],
          });

          const { artifactId } = await ctx.artifacts.writeText({
            type: 'email_summary',
            title: 'Inbox Briefing',
            content: response.text,
          });
          return {
            status: 'completed',
            output: { summary: response.text, artifactId },
            artifactIds: [artifactId],
            costTokens: response.usage.total_tokens,
          };
        } catch (err) {
          logger.error('gmail.summarize LLM call failed', { error: (err as Error).message, dataSize: emailData.length });
          const { artifactId } = await ctx.artifacts.writeText({
            type: 'email_summary',
            title: 'Email Summary',
            content: 'Could not summarize. Raw email data:\n' + emailData.slice(0, 5000),
          });
          return { status: 'completed', output: { summary: 'Summary failed — raw data returned', artifactId }, artifactIds: [artifactId], costTokens: 0 };
        }
      }

      case 'gmail.draft':
      case 'gmail.draft_replies': {
        const upstreamArtifacts = getArtifactsByNodeIds(deps);
        const context = upstreamArtifacts.map(a => a.content ?? '').join('\n');

        const response = await complete({
          model: (node.model as 'fast' | 'balanced' | 'strong') || 'fast',
          messages: [
            { role: 'system', content: 'Draft an email reply. Output the reply text only — no JSON, no headers.' },
            { role: 'user', content: `Context:\n${context}\n\nInstructions: ${input.instructions ?? 'Reply appropriately.'}` },
          ],
        });

        const { artifactId } = await ctx.artifacts.writeText({
          type: 'email_draft',
          title: 'Draft Reply',
          content: response.text,
        });
        return { status: 'completed', output: { draft: response.text, artifactId }, artifactIds: [artifactId], costTokens: response.usage.total_tokens };
      }

      case 'gmail.send': {
        const workspaceTool = getTool('workspace');
        if (!workspaceTool) throw new Error('Workspace tool not loaded');

        const upstreamArtifacts = getArtifactsByNodeIds(deps);
        const draftContent = upstreamArtifacts.map(a => a.content ?? '').join('\n');

        let emailParams = { ...input };
        if (draftContent) {
          try { emailParams = { ...emailParams, ...JSON.parse(draftContent) }; } catch {}
        }

        const to = emailParams.to || emailParams.recipient || '';
        const subject = emailParams.subject || 'Hello';
        let body = emailParams.body || emailParams.message || emailParams.content || '';

        if (!to) throw new Error('No recipient email address provided.');

        let draftTokens = 0;
        if (!body || body.length < 10) {
          const instructions = emailParams.instructions || emailParams.goal || JSON.stringify(emailParams);
          const draftResponse = await complete({
            model: (node.model as 'fast' | 'balanced' | 'strong') || 'fast',
            messages: [
              { role: 'system', content: 'Draft a professional email. Output ONLY the email body text. No subject line, no headers, no markdown.' },
              { role: 'user', content: `Write an email to ${to}. Subject: "${subject}". Instructions: ${instructions}` },
            ],
          });
          body = draftResponse.text;
          draftTokens = draftResponse.usage.total_tokens;
        }

        const rawEmail = [
          'Content-Type: text/plain; charset=utf-8',
          'MIME-Version: 1.0',
          `To: ${to}`,
          `Subject: ${subject}`,
          '',
          body,
        ].join('\r\n');
        const encodedRaw = Buffer.from(rawEmail).toString('base64url');

        console.log('[GMAIL SEND] to:', to, 'subject:', subject, 'body length:', body.length);

        try {
          const sendResult = await workspaceTool.handler(
            { action: 'gmail.send', params: { userId: 'me', raw: encodedRaw } },
            ctx,
          );
          console.log('[GMAIL SEND] result:', JSON.stringify(sendResult).slice(0, 300));

          const { artifactId } = await ctx.artifacts.writeText({
            type: 'email_sent',
            title: `Email to ${to}`,
            content: `To: ${to}\nSubject: ${subject}\n\n${body}`,
          });
          return { status: 'completed', output: { sent: true, to, subject, preview: body.slice(0, 200), artifactId }, artifactIds: [artifactId], costTokens: draftTokens };
        } catch (err) {
          console.log('[GMAIL SEND ERROR]', (err as Error).message);
          throw new Error(`Failed to send email to ${to}: ${(err as Error).message}`);
        }
      }

      case 'calendar.list': {
        const workspaceTool = getTool('workspace');
        if (!workspaceTool) throw new Error('Workspace tool not loaded');
        const result = await workspaceTool.handler({ action: 'calendar.list', params: input || {} }, ctx);
        const calData = (result as any)?.data ?? result;
        const content = typeof calData === 'string' ? calData : JSON.stringify(calData, null, 2);
        const { artifactId } = await ctx.artifacts.writeText({ type: 'calendar_data', title: node.title, content });
        return { status: 'completed', output: { data: calData, artifactId }, artifactIds: [artifactId], costTokens: 0 };
      }

      case 'calendar.propose': {
        const upstreamArtifacts = getArtifactsByNodeIds(deps);
        const context = upstreamArtifacts.map(a => a.content ?? '').join('\n');
        const response = await complete({
          model: (node.model as 'fast' | 'balanced' | 'strong') || 'fast',
          messages: [
            { role: 'system', content: 'Propose follow-up meetings. Output natural text, not JSON.' },
            { role: 'user', content: context || 'No context available.' },
          ],
        });
        const { artifactId } = await ctx.artifacts.writeText({ type: 'calendar_proposals', title: 'Meeting Proposals', content: response.text });
        return { status: 'completed', output: { proposals: response.text, artifactId }, artifactIds: [artifactId], costTokens: response.usage.total_tokens };
      }

      case 'calendar.create': {
        const workspaceTool = getTool('workspace');
        if (!workspaceTool) throw new Error('Workspace tool not loaded');
        const result = await workspaceTool.handler({ action: 'calendar.create', params: input || {} }, ctx);
        return { status: 'completed', output: result, costTokens: 0 };
      }

      default: {
        logger.warn('Unhandled workspace node type', { type: node.type });
        return { status: 'failed', costTokens: 0, error: `Unsupported type: ${node.type}` };
      }
    }
  },
};

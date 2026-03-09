import { z } from 'zod';
import axios from 'axios';
import { getConfig } from '../../core/config.js';
import type { ToolDefinition, ToolContext } from '../sdk/types.js';

const schema = z.object({
  action: z.enum(['search', 'deep']),
  query: z.string().min(1),
});

export const ResearchTool: ToolDefinition<typeof schema> = {
  name: 'research',
  description: 'Web research via Perplexity Sonar (basic search and deep research)',
  version: '1.0.0',
  permissions: ['research.search', 'research.deep'],
  risk: 'low',
  requiredSecrets: [],
  schema,

  jsonSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['search', 'deep'],
        description: 'Type of research: "search" for quick web search, "deep" for in-depth research',
      },
      query: {
        type: 'string',
        description: 'The search query or research topic',
      },
    },
    required: ['action', 'query'],
  },

  async handler(params, ctx: ToolContext) {
    const requiredPerm = params.action === 'deep' ? 'research.deep' : 'research.search';
    if (!ctx.policy.allowPermissions.includes(requiredPerm)) {
      return { status: 'blocked', reason: 'permission_denied', missingPermission: requiredPerm };
    }

    const config = getConfig();
    const researchConfig = config.research;
    const modelId = params.action === 'deep' ? researchConfig.models.deep : researchConfig.models.basic;

    // Route through OpenRouter or direct Perplexity
    const provider = researchConfig.provider;
    let url: string;
    let apiKey: string | undefined;
    let headers: Record<string, string>;

    if (provider === 'openrouter') {
      url = 'https://openrouter.ai/api/v1/chat/completions';
      apiKey = ctx.secrets.get('OPENROUTER_API_KEY');
      headers = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://clawlite.local',
        'X-Title': 'ClawLite',
      };
    } else {
      url = 'https://api.perplexity.ai/chat/completions';
      apiKey = ctx.secrets.get('PERPLEXITY_API_KEY');
      headers = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      };
    }

    if (!apiKey) {
      throw new Error(`API key not configured for research provider "${provider}"`);
    }

    const response = await axios.post(url, {
      model: modelId,
      messages: [
        { role: 'system', content: 'You are a research assistant. Provide accurate, well-sourced information.' },
        { role: 'user', content: params.query },
      ],
    }, { headers, timeout: 120000 });

    const text = response.data.choices?.[0]?.message?.content ?? '';
    const citations = response.data.citations ?? [];
    const usage = response.data.usage ?? {};

    // Store result as artifact
    const { artifactId } = await ctx.artifacts.writeText({
      type: 'research_result',
      title: `Research: ${params.query.slice(0, 50)}`,
      content: text,
    });

    return {
      summary: text,
      citations,
      artifactId,
      costTokens: usage.total_tokens ?? 0,
    };
  },

  async mockHandler(params) {
    return {
      status: 'dry_run',
      action: params.action,
      query: params.query,
      summary: `[DRY RUN] Would search for: ${params.query}`,
      citations: [],
    };
  },
};

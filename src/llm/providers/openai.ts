import { getSecret } from '../../core/secrets.js';
import type { Message, LLMResponse } from '../provider.js';

interface CallParams {
  messages: Message[];
  format?: 'json' | 'text';
}

export async function callOpenAI(
  modelId: string,
  params: CallParams,
): Promise<LLMResponse> {
  const { default: OpenAI } = await import('openai');

  const apiKey = getSecret('OPENAI_API_KEY');
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not configured. Add it to .clawlite/.env');
  }

  const client = new OpenAI({ apiKey });

  const body: Record<string, unknown> = {
    model: modelId,
    messages: params.messages,
  };

  if (params.format === 'json') {
    body.response_format = { type: 'json_object' };
  }

  const response = await client.chat.completions.create(body as Parameters<typeof client.chat.completions.create>[0]);

  const text = response.choices?.[0]?.message?.content ?? '';
  const usage = response.usage;
  const totalTokens = usage?.total_tokens ?? ((usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0));

  const result: LLMResponse = {
    text,
    usage: { total_tokens: totalTokens },
  };

  if (params.format === 'json') {
    try {
      result.parsed = JSON.parse(text);
    } catch {
      // Leave parsed undefined
    }
  }

  return result;
}

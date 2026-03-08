import { getSecret } from '../../core/secrets.js';
import type { LLMResponse, CallParams } from '../provider.js';

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

  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools;
    body.tool_choice = params.tool_choice ?? 'auto';
  }

  const response = await client.chat.completions.create(body as Parameters<typeof client.chat.completions.create>[0]);

  const message = response.choices?.[0]?.message;
  const text = message?.content ?? '';
  const usage = response.usage;
  const totalTokens = usage?.total_tokens ?? ((usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0));
  const finishReason = response.choices?.[0]?.finish_reason;

  const result: LLMResponse = {
    text,
    usage: { total_tokens: totalTokens },
    finishReason: finishReason ?? 'stop',
  };

  if ((message as any)?.tool_calls?.length > 0) {
    result.toolCalls = (message as any).tool_calls;
  }

  if (params.format === 'json' && text) {
    try {
      result.parsed = JSON.parse(text);
    } catch {
      // Leave parsed undefined
    }
  }

  return result;
}

import axios from 'axios';
import { getSecret } from '../../core/secrets.js';
import type { LLMResponse, CallParams } from '../provider.js';

const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';

export async function callMistral(
  modelId: string,
  params: CallParams,
): Promise<LLMResponse> {
  const apiKey = getSecret('MISTRAL_API_KEY');
  if (!apiKey) {
    throw new Error('MISTRAL_API_KEY not configured. Add it to .clawlite/.env');
  }

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

  const response = await axios.post(MISTRAL_URL, body, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 120000,
  });

  const data = response.data;
  const message = data.choices?.[0]?.message;
  const text = message?.content ?? '';
  const usage = data.usage ?? {};
  const totalTokens = usage.total_tokens ?? ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0));
  const finishReason = data.choices?.[0]?.finish_reason;

  const result: LLMResponse = {
    text,
    usage: { total_tokens: totalTokens },
    finishReason: finishReason ?? 'stop',
  };

  if (message?.tool_calls?.length > 0) {
    result.toolCalls = message.tool_calls;
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

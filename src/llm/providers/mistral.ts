import axios from 'axios';
import { getSecret } from '../../core/secrets.js';
import type { Message, LLMResponse } from '../provider.js';

const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';

interface CallParams {
  messages: Message[];
  format?: 'json' | 'text';
}

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

  const response = await axios.post(MISTRAL_URL, body, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 120000,
  });

  const data = response.data;
  const text = data.choices?.[0]?.message?.content ?? '';
  const usage = data.usage ?? {};
  const totalTokens = usage.total_tokens ?? ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0));

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

import axios from 'axios';
import { getSecret } from '../../core/secrets.js';
import type { Message, LLMResponse } from '../provider.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

interface CallParams {
  messages: Message[];
  format?: 'json' | 'text';
}

export async function callOpenRouter(
  modelId: string,
  params: CallParams,
): Promise<LLMResponse> {
  const apiKey = getSecret('OPENROUTER_API_KEY');
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY not configured. Add it to .clawlite/.env');
  }

  const body: Record<string, unknown> = {
    model: modelId,
    messages: params.messages,
  };

  if (params.format === 'json') {
    body.response_format = { type: 'json_object' };
  }

  const response = await axios.post(OPENROUTER_URL, body, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://clawlite.local',
      'X-Title': 'ClawLite',
    },
    timeout: 120000,
  });

  const data = response.data;
  const text = data.choices?.[0]?.message?.content ?? '';
  const usage = data.usage ?? { total_tokens: 0 };

  const result: LLMResponse = {
    text,
    usage: { total_tokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0) },
  };

  if (params.format === 'json') {
    try {
      result.parsed = JSON.parse(text);
    } catch {
      // Leave parsed undefined if JSON parsing fails
    }
  }

  return result;
}

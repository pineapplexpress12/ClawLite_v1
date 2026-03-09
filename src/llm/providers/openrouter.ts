import axios from 'axios';
import { getSecret } from '../../core/secrets.js';
import type { LLMResponse, CallParams } from '../provider.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

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

  // Tool calling support
  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools;
    body.tool_choice = params.tool_choice ?? 'auto';
    body.parallel_tool_calls = false;
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
  const message = data.choices?.[0]?.message;
  const text = message?.content ?? '';
  const usage = data.usage ?? { total_tokens: 0 };
  const finishReason = data.choices?.[0]?.finish_reason;

  const result: LLMResponse = {
    text,
    usage: { total_tokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0) },
    finishReason: finishReason ?? 'stop',
  };

  // Extract tool calls if present
  if (message?.tool_calls && message.tool_calls.length > 0) {
    result.toolCalls = message.tool_calls;
  }

  if (params.format === 'json' && text) {
    try {
      result.parsed = JSON.parse(text);
    } catch {
      // Leave parsed undefined if JSON parsing fails
    }
  }

  return result;
}

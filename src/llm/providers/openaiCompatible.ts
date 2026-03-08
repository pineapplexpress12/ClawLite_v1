import axios from 'axios';
import { getSecret } from '../../core/secrets.js';
import { getConfig } from '../../core/config.js';
import type { Message, LLMResponse } from '../provider.js';

interface CallParams {
  messages: Message[];
  format?: 'json' | 'text';
}

/**
 * Generic OpenAI-compatible provider. Used by xAI, DeepSeek, Groq, Ollama, and custom endpoints.
 */
export async function callOpenAICompatible(
  baseUrl: string,
  modelId: string,
  params: CallParams,
): Promise<LLMResponse> {
  const config = getConfig();
  const provider = config.llm.provider;

  // Determine the API key based on provider
  let apiKey: string | undefined;
  switch (provider) {
    case 'xai':
      apiKey = getSecret('XAI_API_KEY');
      break;
    case 'deepseek':
      apiKey = getSecret('DEEPSEEK_API_KEY');
      break;
    case 'groq':
      apiKey = getSecret('GROQ_API_KEY');
      break;
    case 'ollama':
      apiKey = getSecret('OLLAMA_API_KEY') ?? 'ollama'; // Ollama doesn't require a key
      break;
    case 'custom':
      apiKey = getSecret('CUSTOM_API_KEY') ?? '';
      break;
    default:
      apiKey = '';
  }

  const body: Record<string, unknown> = {
    model: modelId,
    messages: params.messages,
  };

  if (params.format === 'json') {
    body.response_format = { type: 'json_object' };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  const response = await axios.post(url, body, {
    headers,
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

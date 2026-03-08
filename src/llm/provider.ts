import { getConfig } from '../core/config.js';
import { resolveModel, type ModelTier } from './resolveModel.js';
import { callOpenRouter } from './providers/openrouter.js';
import { callAnthropic } from './providers/anthropic.js';
import { callOpenAI } from './providers/openai.js';
import { callGoogleAI } from './providers/google.js';
import { callOpenAICompatible } from './providers/openaiCompatible.js';
import { callMistral } from './providers/mistral.js';

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  text: string;
  parsed?: unknown;
  usage: { total_tokens: number };
}

export interface CompleteParams {
  model: ModelTier;
  messages?: Message[];
  prompt?: string;
  format?: 'json' | 'text';
}

/**
 * Single entry point for all LLM calls. Resolves tier → model ID → provider.
 */
export async function complete(params: CompleteParams): Promise<LLMResponse> {
  const config = getConfig();
  const modelId = resolveModel(params.model);
  const provider = config.llm.provider;

  // Normalize: if only prompt is given, wrap in messages
  const messages: Message[] = params.messages ?? [
    { role: 'user', content: params.prompt ?? '' },
  ];

  const callParams = { messages, format: params.format };

  switch (provider) {
    case 'openrouter':
      return callOpenRouter(modelId, callParams);
    case 'anthropic':
      return callAnthropic(modelId, callParams);
    case 'openai':
      return callOpenAI(modelId, callParams);
    case 'google':
      return callGoogleAI(modelId, callParams);
    case 'xai':
      return callOpenAICompatible('https://api.x.ai/v1', modelId, callParams);
    case 'deepseek':
      return callOpenAICompatible('https://api.deepseek.com/v1', modelId, callParams);
    case 'mistral':
      return callMistral(modelId, callParams);
    case 'groq':
      return callOpenAICompatible('https://api.groq.com/openai/v1', modelId, callParams);
    case 'ollama':
      return callOpenAICompatible(
        (config.llm as Record<string, unknown>).baseUrl as string ?? 'http://localhost:11434/v1',
        modelId,
        callParams,
      );
    case 'custom':
      return callOpenAICompatible(
        (config.llm as Record<string, unknown>).baseUrl as string,
        modelId,
        callParams,
      );
    default:
      throw new Error(`Unsupported LLM provider: ${provider}`);
  }
}

export const llm = { complete };

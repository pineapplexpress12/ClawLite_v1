import { getConfig } from '../core/config.js';
import { resolveModel, type ModelTier } from './resolveModel.js';
import { callOpenRouter } from './providers/openrouter.js';
import { callAnthropic } from './providers/anthropic.js';
import { callOpenAI } from './providers/openai.js';
import { callGoogleAI } from './providers/google.js';
import { callOpenAICompatible } from './providers/openaiCompatible.js';
import { callMistral } from './providers/mistral.js';

// --- Tool-calling types ---

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolCallMessage {
  role: 'assistant';
  content: string | null;
  tool_calls: ToolCall[];
}

export interface ToolResultMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

export interface LLMToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// --- Core types ---

export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }
  | ToolCallMessage
  | ToolResultMessage;

export interface LLMResponse {
  text: string;
  parsed?: unknown;
  usage: { total_tokens: number };
  toolCalls?: ToolCall[];
  finishReason?: string;
}

export interface CompleteParams {
  model: ModelTier;
  messages?: Message[];
  prompt?: string;
  format?: 'json' | 'text';
  tools?: LLMToolDef[];
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
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

  const callParams: CallParams = {
    messages,
    format: params.format,
    tools: params.tools,
    tool_choice: params.tool_choice,
  };

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

/**
 * Shared call params passed to each provider.
 */
export interface CallParams {
  messages: Message[];
  format?: 'json' | 'text';
  tools?: LLMToolDef[];
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
}

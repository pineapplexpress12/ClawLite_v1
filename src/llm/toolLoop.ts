import { complete } from './provider.js';
import type { Message, LLMToolDef, LLMResponse, ToolCallMessage, ToolCall } from './provider.js';
import type { ModelTier } from './resolveModel.js';
import { logger } from '../core/logger.js';

export interface ToolLoopParams {
  model: ModelTier;
  messages: Message[];
  tools: LLMToolDef[];
  toolExecutor: (name: string, argsJson: string) => Promise<unknown>;
  maxIterations?: number;
  maxTokens?: number;
  onToolCall?: (name: string, args: string) => void;
  onToolResult?: (name: string, result: unknown) => void;
}

export interface ToolLoopResult {
  text: string;
  totalTokens: number;
  toolCallsExecuted: number;
  iterations: number;
}

const DEFAULT_MAX_ITERATIONS = 5;
const DEFAULT_MAX_TOKENS = 50000;

/**
 * ReAct-style tool-use loop.
 * Calls the LLM with tools, executes any tool calls, feeds results back,
 * and repeats until the LLM responds with text (no more tool calls).
 */
export async function completeWithTools(params: ToolLoopParams): Promise<ToolLoopResult> {
  const maxIterations = params.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;

  const messages: Message[] = [...params.messages];
  let totalTokens = 0;
  let toolCallsExecuted = 0;
  let iteration = 0;

  while (iteration < maxIterations) {
    // Token budget check
    if (totalTokens >= maxTokens) {
      logger.warn('Tool loop token budget exceeded', { totalTokens, maxTokens });
      break;
    }

    const response: LLMResponse = await complete({
      model: params.model,
      messages,
      tools: params.tools.length > 0 ? params.tools : undefined,
    });

    totalTokens += response.usage.total_tokens;

    // No tool calls — LLM is done, return final text
    if (!response.toolCalls || response.toolCalls.length === 0) {
      return {
        text: response.text,
        totalTokens,
        toolCallsExecuted,
        iterations: iteration + 1,
      };
    }

    // Append assistant message with tool calls
    const assistantMsg: ToolCallMessage = {
      role: 'assistant',
      content: response.text || null,
      tool_calls: response.toolCalls,
    };
    messages.push(assistantMsg);

    // Execute each tool call and collect results
    for (const toolCall of response.toolCalls) {
      params.onToolCall?.(toolCall.function.name, toolCall.function.arguments);

      let result: unknown;
      try {
        result = await params.toolExecutor(toolCall.function.name, toolCall.function.arguments);
      } catch (err) {
        result = { error: (err as Error).message };
        logger.error('Tool execution failed in loop', {
          tool: toolCall.function.name,
          error: (err as Error).message,
        });
      }

      params.onToolResult?.(toolCall.function.name, result);

      // Append tool result message
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });

      toolCallsExecuted++;
    }

    iteration++;
  }

  // Max iterations reached — do one final call without tools to get a text response
  logger.warn('Tool loop max iterations reached, requesting final response', {
    iterations: maxIterations,
    toolCallsExecuted,
  });

  const finalResponse = await complete({
    model: params.model,
    messages,
  });

  totalTokens += finalResponse.usage.total_tokens;

  return {
    text: finalResponse.text || 'I reached my tool-use limit for this turn. Let me know if you need anything else.',
    totalTokens,
    toolCallsExecuted,
    iterations: maxIterations,
  };
}

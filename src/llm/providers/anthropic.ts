import { getSecret } from '../../core/secrets.js';
import type { Message, LLMResponse } from '../provider.js';

interface CallParams {
  messages: Message[];
  format?: 'json' | 'text';
}

export async function callAnthropic(
  modelId: string,
  params: CallParams,
): Promise<LLMResponse> {
  // Dynamic import to avoid requiring @anthropic-ai/sdk when not used
  const { default: Anthropic } = await import('@anthropic-ai/sdk');

  const apiKey = getSecret('ANTHROPIC_API_KEY');
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured. Add it to .clawlite/.env');
  }

  const client = new Anthropic({ apiKey });

  // Separate system message from conversation messages
  const systemMsg = params.messages.find(m => m.role === 'system');
  const conversationMsgs = params.messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  // Ensure at least one user message
  if (conversationMsgs.length === 0) {
    conversationMsgs.push({ role: 'user' as const, content: '' });
  }

  let systemPrompt = systemMsg?.content;
  if (params.format === 'json' && systemPrompt) {
    systemPrompt += '\n\nRespond with valid JSON only. No markdown formatting.';
  }

  const response = await client.messages.create({
    model: modelId,
    max_tokens: 4096,
    system: systemPrompt,
    messages: conversationMsgs,
  });

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('');

  const totalTokens = (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0);

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

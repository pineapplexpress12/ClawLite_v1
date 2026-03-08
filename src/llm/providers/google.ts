import axios from 'axios';
import { getSecret } from '../../core/secrets.js';
import type { LLMResponse, CallParams } from '../provider.js';

const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export async function callGoogleAI(
  modelId: string,
  params: CallParams,
): Promise<LLMResponse> {
  const apiKey = getSecret('GOOGLE_API_KEY');
  if (!apiKey) {
    throw new Error('GOOGLE_API_KEY not configured. Add it to .clawlite/.env');
  }

  // Convert messages to Google's format (skip tool messages)
  const systemMsg = params.messages.find(m => m.role === 'system');
  const conversationMsgs = params.messages.filter(m => m.role !== 'system' && m.role !== 'tool');

  const contents = conversationMsgs.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: 'content' in m && typeof m.content === 'string' ? m.content : '' }],
  }));

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {},
  };

  if (systemMsg && 'content' in systemMsg) {
    body.systemInstruction = { parts: [{ text: systemMsg.content }] };
  }

  if (params.format === 'json') {
    (body.generationConfig as Record<string, unknown>).responseMimeType = 'application/json';
  }

  const url = `${GOOGLE_API_BASE}/${modelId}:generateContent?key=${apiKey}`;

  const response = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 120000,
  });

  const data = response.data;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const usageMeta = data.usageMetadata ?? {};
  const totalTokens = (usageMeta.promptTokenCount ?? 0) + (usageMeta.candidatesTokenCount ?? 0);

  const result: LLMResponse = {
    text,
    usage: { total_tokens: totalTokens },
    finishReason: 'stop',
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

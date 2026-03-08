import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config and secrets
vi.mock('../../src/core/config.js', () => ({
  getConfig: () => ({
    llm: {
      provider: 'openrouter',
      tiers: {
        fast: 'google/gemini-3-flash',
        balanced: 'anthropic/claude-sonnet-4-6',
        strong: 'anthropic/claude-opus-4-6',
      },
    },
  }),
}));

vi.mock('../../src/core/secrets.js', () => ({
  getSecret: (key: string) => {
    if (key === 'OPENROUTER_API_KEY') return 'sk-or-test-123';
    return undefined;
  },
  hasSecret: () => true,
}));

// Mock axios to avoid real API calls
vi.mock('axios', () => ({
  default: {
    post: vi.fn().mockResolvedValue({
      data: {
        choices: [{ message: { content: '{"answer": "hello"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    }),
  },
}));

import { resolveModel } from '../../src/llm/resolveModel.js';
import { complete } from '../../src/llm/provider.js';
import axios from 'axios';

describe('resolveModel', () => {
  it('should resolve fast tier to model ID', () => {
    expect(resolveModel('fast')).toBe('google/gemini-3-flash');
  });

  it('should resolve balanced tier to model ID', () => {
    expect(resolveModel('balanced')).toBe('anthropic/claude-sonnet-4-6');
  });

  it('should resolve strong tier to model ID', () => {
    expect(resolveModel('strong')).toBe('anthropic/claude-opus-4-6');
  });
});

describe('complete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call OpenRouter with correct parameters', async () => {
    const result = await complete({
      model: 'fast',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ],
    });

    expect(result.text).toBe('{"answer": "hello"}');
    expect(result.usage.total_tokens).toBe(15);

    expect(axios.post).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({
        model: 'google/gemini-3-flash',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello' },
        ],
      }),
      expect.any(Object),
    );
  });

  it('should set response_format for JSON mode', async () => {
    await complete({
      model: 'fast',
      messages: [{ role: 'user', content: 'Respond in JSON' }],
      format: 'json',
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        response_format: { type: 'json_object' },
      }),
      expect.any(Object),
    );
  });

  it('should parse JSON response when format is json', async () => {
    const result = await complete({
      model: 'fast',
      messages: [{ role: 'user', content: 'Respond in JSON' }],
      format: 'json',
    });

    expect(result.parsed).toEqual({ answer: 'hello' });
  });

  it('should handle prompt shorthand', async () => {
    await complete({
      model: 'fast',
      prompt: 'Hello there',
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        messages: [{ role: 'user', content: 'Hello there' }],
      }),
      expect.any(Object),
    );
  });

  it('should include OpenRouter-specific headers', async () => {
    await complete({
      model: 'fast',
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer sk-or-test-123',
          'HTTP-Referer': 'https://clawlite.local',
          'X-Title': 'ClawLite',
        }),
      }),
    );
  });
});

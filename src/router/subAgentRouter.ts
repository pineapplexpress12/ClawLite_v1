import { complete } from '../llm/provider.js';
import { getActiveSubAgents, type SubAgentRow } from '../db/subAgents.js';

export interface SubAgentRouteResult {
  target: 'operator' | string;
  subAgent: SubAgentRow | null;
  confidence: number;
}

/**
 * Route a message to the correct sub-agent (if any).
 * Uses fast-tier LLM classification when sub-agents are active.
 */
export async function routeToSubAgent(message: string): Promise<SubAgentRouteResult> {
  const subAgents = getActiveSubAgents();

  if (subAgents.length === 0) {
    return { target: 'operator', subAgent: null, confidence: 1.0 };
  }

  const agentList = subAgents
    .map(a => `- ${a.name}: ${a.description}`)
    .join('\n');

  const result = await complete({
    model: 'fast',
    format: 'json',
    messages: [
      {
        role: 'user',
        content: `You are a message router. Given the user's message, determine which sub-agent should handle it, or "operator" if it's a general request.

Message: "${message}"

Available sub-agents:
${agentList}

Respond with JSON: { "target": "sub-agent-name" | "operator", "confidence": 0.0-1.0 }`,
      },
    ],
  });

  const parsed = result.parsed as { target?: string; confidence?: number } | undefined;

  if (!parsed || parsed.target === 'operator' || (parsed.confidence ?? 0) < 0.5) {
    return { target: 'operator', subAgent: null, confidence: parsed?.confidence ?? 0 };
  }

  const matched = subAgents.find(a => a.name === parsed.target);
  if (!matched) {
    return { target: 'operator', subAgent: null, confidence: 0 };
  }

  return {
    target: parsed.target!,
    subAgent: matched,
    confidence: parsed.confidence ?? 0,
  };
}

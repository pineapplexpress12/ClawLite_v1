import { complete } from '../llm/provider.js';
import { getAllTemplates, getTemplateBySlashCommand, type GraphTemplate } from './templates.js';

export interface SelectionResult {
  template: GraphTemplate | null;
  confidence: number;
  topCandidates: string[];
  fallback: 'none' | 'agentic' | 'chat';
}

/**
 * Select the best template for a user message.
 * Tier 1: Slash command → direct match (100% confidence)
 * Tier 2: LLM classification with confidence scoring
 * Tier 3: Confidence gating → template / agentic fallback / chat
 */
export async function selectTemplate(message: string): Promise<SelectionResult> {
  // Tier 1: Slash command direct match
  if (message.startsWith('/')) {
    const match = getTemplateBySlashCommand(message);
    if (match) {
      return { template: match, confidence: 1.0, topCandidates: [match.id], fallback: 'none' };
    }
  }

  // Tier 2: LLM classification
  const templates = getAllTemplates();
  const templateList = templates
    .map(t => `- id: "${t.id}" — ${t.description}`)
    .join('\n');

  const result = await complete({
    model: 'fast',
    messages: [
      {
        role: 'user',
        content: `You are a request classifier. Given the user message below, select the BEST matching template.

Available templates:
${templateList}

User message: "${message}"

Respond with JSON only:
{
  "templateId": "string — the best match, or 'none' if nothing fits",
  "confidence": number between 0.0 and 1.0,
  "topCandidates": ["id1", "id2"]
}`,
      },
    ],
    format: 'json',
  });

  const parsed = result.parsed as { templateId?: string; confidence?: number; topCandidates?: string[] } | undefined;

  if (!parsed || parsed.templateId === 'none') {
    return { template: null, confidence: 0, topCandidates: parsed?.topCandidates ?? [], fallback: 'chat' };
  }

  const matched = templates.find(t => t.id === parsed.templateId);
  const confidence = parsed.confidence ?? 0;

  // Tier 3: Confidence gating
  if (confidence >= 0.7 && matched) {
    return { template: matched, confidence, topCandidates: parsed.topCandidates ?? [], fallback: 'none' };
  } else if (confidence >= 0.3) {
    return { template: matched ?? null, confidence, topCandidates: parsed.topCandidates ?? [], fallback: 'agentic' };
  } else {
    return { template: null, confidence, topCandidates: parsed.topCandidates ?? [], fallback: 'chat' };
  }
}

import { complete } from '../llm/provider.js';
import type { GraphTemplate } from './templates.js';

/**
 * Extract slot values from a user message using fast-tier LLM.
 */
export async function extractSlots(
  template: GraphTemplate,
  message: string,
): Promise<Record<string, unknown>> {
  if (template.slots.length === 0) {
    return {};
  }

  const slotDescriptions = template.slots
    .map(s => `- ${s.name}: ${s.description}${s.required ? ' (required)' : ' (optional)'}`)
    .join('\n');

  const result = await complete({
    model: 'fast',
    messages: [
      {
        role: 'user',
        content: `Extract these fields from the user message:
${slotDescriptions}

User message: "${message}"

Respond with JSON only. Use null for optional fields that are not mentioned.`,
      },
    ],
    format: 'json',
  });

  const parsed = (result.parsed ?? {}) as Record<string, unknown>;

  // Apply defaults for missing optional slots
  const filled: Record<string, unknown> = {};
  for (const slot of template.slots) {
    const value = parsed[slot.name];
    if (value !== undefined && value !== null) {
      filled[slot.name] = value;
    } else {
      filled[slot.name] = slot.default ?? null;
    }
  }

  return filled;
}

/**
 * Extract slot values from slash command arguments.
 */
export function extractSlashArgs(
  template: GraphTemplate,
  argsStr: string,
): Record<string, unknown> {
  const slots: Record<string, unknown> = {};

  // Apply defaults first
  for (const slot of template.slots) {
    slots[slot.name] = slot.default ?? null;
  }

  // Simple heuristic: if only one required slot, assign the full args string to it
  const requiredSlots = template.slots.filter(s => s.required);
  if (requiredSlots.length === 1 && argsStr.trim()) {
    slots[requiredSlots[0]!.name] = argsStr.trim();
  }

  return slots;
}

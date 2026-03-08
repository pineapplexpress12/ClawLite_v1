import { getConfig } from '../core/config.js';

export type ModelTier = 'fast' | 'balanced' | 'strong';

/**
 * Resolve an abstract tier name to a provider-specific model ID.
 */
export function resolveModel(tier: ModelTier): string {
  const config = getConfig();
  const modelId = config.llm.tiers[tier];
  if (!modelId) {
    throw new Error(`No model configured for tier "${tier}"`);
  }
  return modelId;
}

/**
 * Get the configured LLM provider name.
 */
export function getProvider(): string {
  return getConfig().llm.provider;
}

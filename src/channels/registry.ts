import type { ChannelAdapter } from './types.js';
import { logger } from '../core/logger.js';

const adapters = new Map<string, ChannelAdapter>();

/**
 * Register a channel adapter.
 */
export function registerChannel(adapter: ChannelAdapter): void {
  adapters.set(adapter.name, adapter);
  logger.info('Channel registered', { name: adapter.name });
}

/**
 * Get a channel adapter by name.
 */
export function getChannel(name: string): ChannelAdapter | undefined {
  return adapters.get(name);
}

/**
 * Get all registered adapters.
 */
export function getEnabledChannels(): ChannelAdapter[] {
  return Array.from(adapters.values());
}

/**
 * Start all registered channel adapters.
 */
export async function startAllChannels(): Promise<void> {
  for (const adapter of adapters.values()) {
    try {
      await adapter.start();
      logger.info('Channel started', { name: adapter.name });
    } catch (err) {
      logger.error('Channel failed to start', { name: adapter.name, error: (err as Error).message });
    }
  }
}

/**
 * Stop all registered channel adapters.
 */
export async function stopAllChannels(): Promise<void> {
  for (const adapter of adapters.values()) {
    try {
      await adapter.stop();
      logger.info('Channel stopped', { name: adapter.name });
    } catch (err) {
      logger.error('Channel failed to stop', { name: adapter.name, error: (err as Error).message });
    }
  }
}

/**
 * Clear all channels (for testing).
 */
export function clearChannels(): void {
  adapters.clear();
}

import { getConfig } from '../../core/config.js';

/**
 * Check if a user is authorized for a given channel.
 * Checks per-channel allowlist in config.
 */
export function isAuthorized(channelName: string, userId: string): boolean {
  const config = getConfig();
  const channels = config.channels as Record<string, { enabled?: boolean; allowedUserIds?: (string | number)[] }>;
  const channelConfig = channels[channelName];

  if (!channelConfig?.enabled) return false;

  // If no allowlist, allow all (for webchat)
  if (!channelConfig.allowedUserIds || channelConfig.allowedUserIds.length === 0) {
    return true;
  }

  return channelConfig.allowedUserIds.some(id => String(id) === String(userId));
}

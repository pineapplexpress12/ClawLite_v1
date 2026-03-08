import type { ChannelAdapter, OutboundMessage } from '../types.js';

const CHANNEL_LIMITS: Record<string, number> = {
  telegram: 4096,
  whatsapp: 4096,
  discord: 2000,
  slack: 3000,
  webchat: 10000,
};

/**
 * Split a long message into chunks that fit within channel limits.
 * Sends each chunk sequentially.
 */
export async function sendLongMessage(
  adapter: ChannelAdapter,
  chatId: string,
  text: string,
  parseMode?: 'plain' | 'markdown' | 'html',
): Promise<void> {
  const limit = CHANNEL_LIMITS[adapter.name] ?? 4096;

  if (text.length <= limit) {
    await adapter.sendMessage(chatId, { text, parseMode });
    return;
  }

  // Split on paragraph breaks first, then by limit
  const chunks = splitText(text, limit);

  for (const chunk of chunks) {
    await adapter.sendMessage(chatId, { text: chunk, parseMode });
  }
}

function splitText(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    // Try to split at paragraph break
    let splitIdx = remaining.lastIndexOf('\n\n', maxLength);
    if (splitIdx < maxLength / 2) {
      // Try line break
      splitIdx = remaining.lastIndexOf('\n', maxLength);
    }
    if (splitIdx < maxLength / 2) {
      // Force split at limit
      splitIdx = maxLength;
    }

    chunks.push(remaining.slice(0, splitIdx).trim());
    remaining = remaining.slice(splitIdx).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

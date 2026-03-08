import { routeMessage } from '../../router/messageRouter.js';
import { handleCommand } from './commands.js';
import { handleSystemCommand } from './systemCommands.js';
import { handleProfileCommand } from './profileCommands.js';
import { handleHeartbeatCommand } from './heartbeatCommands.js';
import { handleChat } from './chat.js';
import { handleComplex } from './complex.js';
import { handleFileUpload, type Attachment } from './fileUpload.js';
import { storeTurn } from '../../session/sessionManager.js';
import { logger } from '../../core/logger.js';

export interface InboundMessage {
  channelName: string;
  chatId: string;
  userId: string;
  text: string;
  attachments?: Attachment[];
}

export interface MessageHandlerDeps {
  sendMessage: (chatId: string, text: string) => Promise<void>;
  isAuthorized: (channelName: string, userId: string) => boolean;
}

/**
 * Shared message handler — the main entry point for all channel adapters.
 * Flow: auth → session → file upload → route → handler
 */
export async function handleInboundMessage(
  msg: InboundMessage,
  deps: MessageHandlerDeps,
): Promise<void> {
  // 1. Authorization
  if (!deps.isAuthorized(msg.channelName, msg.userId)) {
    await deps.sendMessage(msg.chatId, 'Unauthorized.');
    return;
  }

  const sendMessage = async (text: string) => deps.sendMessage(msg.chatId, text);

  // 2. Handle file attachments
  if (msg.attachments && msg.attachments.length > 0) {
    await handleFileUpload(msg.attachments, {
      channelName: msg.channelName,
      chatId: msg.chatId,
      sendMessage,
    });
    // If no text, we're done (file upload handler already acknowledged)
    if (!msg.text?.trim()) return;
  }

  // 3. Store user message in session
  if (msg.text?.trim()) {
    storeTurn(msg.chatId, msg.channelName, 'user', msg.text);
  }

  // 4. Route the message
  const text = msg.text?.trim() ?? '';
  if (!text) return;

  const intent = routeMessage(text);

  const ctx = {
    channelName: msg.channelName,
    chatId: msg.chatId,
    sendMessage,
  };

  switch (intent) {
    case 'command': {
      const spaceIdx = text.indexOf(' ');
      const command = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
      const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

      // Try workflow commands first
      const handled = await handleCommand(text, ctx);
      if (handled) return;

      // Try system commands
      if (await handleSystemCommand(command, args, ctx)) return;

      // Try profile commands
      if (await handleProfileCommand(command, args, ctx)) return;

      // Try heartbeat commands
      if (await handleHeartbeatCommand(command, args, ctx)) return;

      // Unknown command
      await sendMessage(`Unknown command: ${command}. Type /help for available commands.`);
      break;
    }

    case 'chat':
      await handleChat(text, ctx);
      break;

    case 'complex':
      await handleComplex(text, ctx);
      break;
  }
}

import type { ChannelAdapter, InboundMessage, OutboundMessage, ApprovalRequest, ApprovalAction } from '../types.js';
import { getSecret } from '../../core/secrets.js';
import { logger } from '../../core/logger.js';

type MessageHandler = (msg: InboundMessage) => Promise<void>;
type ApprovalHandler = (action: ApprovalAction) => Promise<void>;

/**
 * Telegram channel adapter using node-telegram-bot-api.
 * Uses polling mode for simplicity.
 */
export class TelegramAdapter implements ChannelAdapter {
  name = 'telegram';
  private bot: any = null;
  private messageHandler: MessageHandler | null = null;
  private approvalHandler: ApprovalHandler | null = null;

  async start(): Promise<void> {
    const token = getSecret('TELEGRAM_BOT_TOKEN');
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN not configured');
    }

    // Dynamic import to avoid requiring the package when telegram is disabled
    const TelegramBot = (await import('node-telegram-bot-api')).default;
    this.bot = new TelegramBot(token, { polling: true });

    // Message handler
    this.bot.on('message', async (msg: any) => {
      if (!this.messageHandler) return;

      const inbound: InboundMessage = {
        channelName: 'telegram',
        chatId: String(msg.chat.id),
        userId: String(msg.from?.id ?? msg.chat.id),
        text: msg.text ?? '',
        attachments: [],
      };

      // Handle file uploads
      if (msg.document) {
        inbound.attachments = [{
          filename: msg.document.file_name,
          mimeType: msg.document.mime_type ?? 'application/octet-stream',
          type: 'document',
          size: msg.document.file_size ?? 0,
        }];
      } else if (msg.photo) {
        const photo = msg.photo[msg.photo.length - 1];
        inbound.attachments = [{
          filename: `photo_${photo.file_id}.jpg`,
          mimeType: 'image/jpeg',
          type: 'image',
          size: photo.file_size ?? 0,
        }];
      }

      try {
        await this.messageHandler(inbound);
      } catch (err) {
        logger.error('Telegram message handler error', { error: (err as Error).message });
      }
    });

    // Callback query handler (for approval buttons)
    this.bot.on('callback_query', async (query: any) => {
      if (!this.approvalHandler || !query.data) return;

      try {
        const data = JSON.parse(query.data);
        await this.approvalHandler({
          approvalId: data.approvalId,
          action: data.action,
        });

        // Answer the callback to remove loading state
        await this.bot.answerCallbackQuery(query.id, { text: `Action: ${data.action}` });
      } catch (err) {
        logger.error('Telegram callback query error', { error: (err as Error).message });
      }
    });

    logger.info('Telegram adapter started');
  }

  async stop(): Promise<void> {
    if (this.bot) {
      this.bot.stopPolling();
      this.bot = null;
    }
    logger.info('Telegram adapter stopped');
  }

  async sendMessage(chatId: string, message: OutboundMessage): Promise<void> {
    if (!this.bot) throw new Error('Telegram bot not initialized');

    const opts: Record<string, unknown> = {};
    if (message.parseMode === 'markdown') {
      opts.parse_mode = 'Markdown';
    } else if (message.parseMode === 'html') {
      opts.parse_mode = 'HTML';
    }

    await this.bot.sendMessage(chatId, message.text, opts);
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.sendChatAction(chatId, 'typing');
  }

  async sendApprovalRequest(request: ApprovalRequest): Promise<void> {
    if (!this.bot) return;

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: 'Approve',
            callback_data: JSON.stringify({ approvalId: request.approvalId, action: 'approve' }),
          },
          {
            text: 'Reject',
            callback_data: JSON.stringify({ approvalId: request.approvalId, action: 'reject' }),
          },
        ],
      ],
    };

    const text = `*Approval Required*\n${request.title}\n\n${request.preview}`;
    await this.bot.sendMessage(request.chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onApprovalAction(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }
}

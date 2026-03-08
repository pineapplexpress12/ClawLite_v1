import type { ChannelAdapter, InboundMessage, OutboundMessage, ApprovalRequest, ApprovalAction } from '../types.js';
import { logger } from '../../core/logger.js';

type MessageHandler = (msg: InboundMessage) => Promise<void>;
type ApprovalHandler = (action: ApprovalAction) => Promise<void>;

/**
 * WhatsApp channel adapter using Baileys.
 */
export class WhatsAppAdapter implements ChannelAdapter {
  name = 'whatsapp';
  private sock: any = null;
  private messageHandler: MessageHandler | null = null;
  private approvalHandler: ApprovalHandler | null = null;

  async start(): Promise<void> {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } =
      await import('@whiskeysockets/baileys');

    const { state, saveCreds } = await useMultiFileAuthState('.clawlite/wa-auth');

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async ({ messages }: any) => {
      if (!this.messageHandler) return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        const text = msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text || '';

        await this.messageHandler({
          channelName: 'whatsapp',
          chatId: msg.key.remoteJid!,
          userId: msg.key.remoteJid!,
          text,
        });
      }
    });

    logger.info('WhatsApp adapter started (scan QR if needed)');
  }

  async stop(): Promise<void> {
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    logger.info('WhatsApp adapter stopped');
  }

  async sendMessage(chatId: string, message: OutboundMessage): Promise<void> {
    if (!this.sock) return;
    await this.sock.sendMessage(chatId, { text: message.text });
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onApprovalAction(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }
}

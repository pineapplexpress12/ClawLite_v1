import type { ChannelAdapter, InboundMessage, OutboundMessage, ApprovalRequest, ApprovalAction } from '../types.js';
import { getSecret } from '../../core/secrets.js';
import { logger } from '../../core/logger.js';

type MessageHandler = (msg: InboundMessage) => Promise<void>;
type ApprovalHandler = (action: ApprovalAction) => Promise<void>;

/**
 * Discord channel adapter using discord.js.
 */
export class DiscordAdapter implements ChannelAdapter {
  name = 'discord';
  private client: any = null;
  private messageHandler: MessageHandler | null = null;
  private approvalHandler: ApprovalHandler | null = null;

  async start(): Promise<void> {
    const token = getSecret('DISCORD_BOT_TOKEN');
    if (!token) throw new Error('DISCORD_BOT_TOKEN not configured');

    const { Client, GatewayIntentBits } = await import('discord.js');
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on('messageCreate', async (msg: any) => {
      if (msg.author.bot) return;
      if (!this.messageHandler) return;

      await this.messageHandler({
        channelName: 'discord',
        chatId: msg.channel.id,
        userId: msg.author.id,
        text: msg.content,
      });
    });

    await this.client.login(token);
    logger.info('Discord adapter started');
  }

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.destroy();
      this.client = null;
    }
    logger.info('Discord adapter stopped');
  }

  async sendMessage(chatId: string, message: OutboundMessage): Promise<void> {
    if (!this.client) return;
    const channel = await this.client.channels.fetch(chatId);
    if (channel?.isTextBased()) {
      // Discord has 2000 char limit
      const text = message.text.slice(0, 2000);
      await channel.send(text);
    }
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onApprovalAction(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }
}

import type { ChannelAdapter, InboundMessage, OutboundMessage, ApprovalRequest, ApprovalAction } from '../types.js';
import { getSecret } from '../../core/secrets.js';
import { logger } from '../../core/logger.js';

type MessageHandler = (msg: InboundMessage) => Promise<void>;
type ApprovalHandler = (action: ApprovalAction) => Promise<void>;

/**
 * Slack channel adapter using @slack/bolt.
 */
export class SlackAdapter implements ChannelAdapter {
  name = 'slack';
  private app: any = null;
  private messageHandler: MessageHandler | null = null;
  private approvalHandler: ApprovalHandler | null = null;

  async start(): Promise<void> {
    const token = getSecret('SLACK_BOT_TOKEN');
    const signingSecret = getSecret('SLACK_SIGNING_SECRET');
    const appToken = getSecret('SLACK_APP_TOKEN');
    if (!token || !signingSecret) throw new Error('SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET required');

    const { App } = await import('@slack/bolt');
    this.app = new App({
      token,
      signingSecret,
      socketMode: !!appToken,
      appToken,
    });

    this.app.message(async ({ message, say }: any) => {
      if (!this.messageHandler || message.subtype) return;

      await this.messageHandler({
        channelName: 'slack',
        chatId: message.channel,
        userId: message.user,
        text: message.text ?? '',
      });
    });

    await this.app.start();
    logger.info('Slack adapter started');
  }

  async stop(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
    }
    logger.info('Slack adapter stopped');
  }

  async sendMessage(chatId: string, message: OutboundMessage): Promise<void> {
    if (!this.app) return;
    await this.app.client.chat.postMessage({
      channel: chatId,
      text: message.text,
    });
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onApprovalAction(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }
}

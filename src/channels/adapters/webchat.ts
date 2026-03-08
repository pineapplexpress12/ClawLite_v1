import type { ChannelAdapter, InboundMessage, OutboundMessage, ApprovalRequest, ApprovalAction } from '../types.js';
import { logger } from '../../core/logger.js';

type MessageHandler = (msg: InboundMessage) => Promise<void>;
type ApprovalHandler = (action: ApprovalAction) => Promise<void>;

/**
 * WebChat adapter using WebSocket on Fastify.
 * Clients connect via ws:// and exchange JSON messages.
 */
export class WebChatAdapter implements ChannelAdapter {
  name = 'webchat';
  private connections = new Map<string, any>();
  private messageHandler: MessageHandler | null = null;
  private approvalHandler: ApprovalHandler | null = null;
  private fastifyInstance: any = null;

  setFastify(fastify: any): void {
    this.fastifyInstance = fastify;
  }

  async start(): Promise<void> {
    if (!this.fastifyInstance) {
      logger.warn('WebChat: No Fastify instance set. WebChat will be available when HTTP server starts.');
      return;
    }

    // WebSocket route
    this.fastifyInstance.get('/ws', { websocket: true }, (socket: any) => {
      const chatId = `webchat_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      this.connections.set(chatId, socket);

      // Send welcome
      socket.send(JSON.stringify({
        type: 'connected',
        chatId,
      }));

      socket.on('message', async (data: any) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === 'message' && this.messageHandler) {
            await this.messageHandler({
              channelName: 'webchat',
              chatId: msg.chatId ?? chatId,
              userId: msg.userId ?? chatId,
              text: msg.text ?? '',
            });
          } else if (msg.type === 'approval' && this.approvalHandler) {
            await this.approvalHandler({
              approvalId: msg.approvalId,
              action: msg.action,
            });
          }
        } catch (err) {
          logger.error('WebChat message parse error', { error: (err as Error).message });
        }
      });

      socket.on('close', () => {
        this.connections.delete(chatId);
      });
    });

    logger.info('WebChat adapter started');
  }

  async stop(): Promise<void> {
    for (const [, socket] of this.connections) {
      socket.close();
    }
    this.connections.clear();
    logger.info('WebChat adapter stopped');
  }

  async sendMessage(chatId: string, message: OutboundMessage): Promise<void> {
    const socket = this.connections.get(chatId);
    if (!socket) {
      // Try to find by prefix match (chatId might be shortened)
      for (const [id, s] of this.connections) {
        if (id.startsWith(chatId) || chatId.startsWith(id)) {
          s.send(JSON.stringify({ type: 'message', text: message.text }));
          return;
        }
      }
      return;
    }

    socket.send(JSON.stringify({
      type: 'message',
      text: message.text,
      parseMode: message.parseMode,
    }));
  }

  async sendApprovalRequest(request: ApprovalRequest): Promise<void> {
    const socket = this.connections.get(request.chatId);
    if (!socket) return;

    socket.send(JSON.stringify({
      type: 'approval',
      approvalId: request.approvalId,
      title: request.title,
      preview: request.preview,
      actions: ['approve', 'reject'],
    }));
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onApprovalAction(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }
}

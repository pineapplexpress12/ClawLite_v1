import Fastify from 'fastify';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../core/config.js';
import { logger } from '../core/logger.js';
import { registerWebhookRoutes } from './webhooks.js';
import { registerArtifactRoutes } from './artifacts.js';
import { registerStatusRoutes } from './status.js';
import type { InboundMessage, OutboundMessage } from '../channels/types.js';

let fastifyInstance: ReturnType<typeof Fastify> | null = null;

// WebChat connection management — shared between server and adapter
const wsConnections = new Map<string, any>();
let webchatMessageHandler: ((msg: InboundMessage) => Promise<void>) | null = null;

/**
 * Initialize and start the Fastify HTTP server.
 * Registers all route modules, WebChat WebSocket, and static SPA.
 * All routes must be registered BEFORE listen().
 */
export async function startHTTPServer(): Promise<ReturnType<typeof Fastify>> {
  const config = getConfig();
  const { port, host } = config.http;

  const fastify = Fastify({ logger: false });
  fastifyInstance = fastify;

  // Register plugins
  await fastify.register(import('@fastify/websocket'));
  await fastify.register(import('@fastify/multipart'), { limits: { fileSize: 25 * 1024 * 1024 } });
  await fastify.register(import('@fastify/cors'), { origin: true });

  // Serve WebChat static SPA at root
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const staticDir = join(__dirname, '..', 'channels', 'webchat', 'static');
  await fastify.register(import('@fastify/static'), {
    root: staticDir,
    prefix: '/',
  });

  // Register WebSocket route for WebChat (must be before listen)
  if (config.channels.webchat.enabled) {
    fastify.get('/ws', { websocket: true }, (socket: any) => {
      const chatId = `webchat_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      wsConnections.set(chatId, socket);

      socket.send(JSON.stringify({ type: 'connected', chatId }));

      socket.on('message', async (data: any) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === 'message' && webchatMessageHandler) {
            await webchatMessageHandler({
              channelName: 'webchat',
              chatId: msg.chatId ?? chatId,
              userId: msg.userId ?? chatId,
              text: msg.text ?? '',
            });
          }
        } catch (err) {
          logger.error('WebChat message parse error', { error: (err as Error).message });
        }
      });

      socket.on('close', () => {
        wsConnections.delete(chatId);
      });
    });
  }

  // Register route modules
  registerWebhookRoutes(fastify);
  registerArtifactRoutes(fastify);
  registerStatusRoutes(fastify);

  await fastify.listen({ port, host });
  logger.info('HTTP server started', { port, host });

  return fastify;
}

/**
 * Set the handler for incoming WebChat messages.
 * Called from index.ts after HTTP server starts.
 */
export function setWebchatMessageHandler(handler: (msg: InboundMessage) => Promise<void>): void {
  webchatMessageHandler = handler;
}

/**
 * Send a message to a WebChat client by chatId.
 */
export function sendWebchatMessage(chatId: string, message: OutboundMessage): void {
  const socket = wsConnections.get(chatId);
  if (socket) {
    socket.send(JSON.stringify({ type: 'message', text: message.text }));
    return;
  }
  // Try prefix match (chatId might be shortened)
  for (const [id, s] of wsConnections) {
    if (id.startsWith(chatId) || chatId.startsWith(id)) {
      s.send(JSON.stringify({ type: 'message', text: message.text }));
      return;
    }
  }
}

/**
 * Stop the HTTP server.
 */
export async function stopHTTPServer(): Promise<void> {
  if (fastifyInstance) {
    for (const [, socket] of wsConnections) {
      socket.close();
    }
    wsConnections.clear();
    await fastifyInstance.close();
    fastifyInstance = null;
    logger.info('HTTP server stopped');
  }
}

/**
 * Get the current Fastify instance.
 */
export function getFastifyInstance(): ReturnType<typeof Fastify> | null {
  return fastifyInstance;
}

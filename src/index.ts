import { loadConfig, getConfig } from './core/config.js';
import { initDb } from './db/connection.js';
import { runMigrations } from './db/schema.js';
import { logger } from './core/logger.js';
import { startHTTPServer, setWebchatMessageHandler, sendWebchatMessage } from './http/server.js';
import { startAllChannels } from './channels/registry.js';
import { startHeartbeat } from './heartbeat/scheduler.js';
import { recoverChannelState } from './channels/shared/recovery.js';
import { gracefulShutdown, recoverCrashedJobs } from './lifecycle.js';
import { loadSecrets } from './core/secrets.js';
import { seedDefaultSubAgents } from './db/subAgents.js';
import { handleInboundMessage } from './channels/handlers/message.js';
import { isAuthorized } from './channels/shared/auth.js';

/**
 * Main entry point — starts ClawLite in the correct order.
 * See CHANNEL_ADAPTERS.md Section 18 for boot sequence.
 */
export async function startClawLite(): Promise<void> {
  // 1. Load config + secrets
  loadConfig();
  loadSecrets();
  const config = getConfig();
  logger.info('Config loaded', { operator: config.operator.name });

  // 2. Initialize database
  const db = initDb();
  runMigrations(db);
  seedDefaultSubAgents();
  logger.info('Database initialized');

  // 3. Start HTTP server (registers WebSocket route before listen)
  if (config.http.enabled) {
    await startHTTPServer();

    // Wire up WebChat message handler
    if (config.channels.webchat.enabled) {
      setWebchatMessageHandler(async (msg) => {
        await handleInboundMessage(msg, {
          sendMessage: async (chatId, text) => {
            sendWebchatMessage(chatId, { text });
          },
          isAuthorized,
        });
      });
    }
  }

  // 4. Start all enabled channels
  await startAllChannels();
  logger.info(`${config.operator.name} is online`);

  // 5. Recover interrupted state
  recoverChannelState();
  recoverCrashedJobs();

  // 6. Start heartbeat
  if (config.heartbeat.enabled) {
    startHeartbeat(config.heartbeat.intervalMinutes);
  }

  logger.info('Recovery complete. Ready.');

  // Graceful shutdown handlers
  process.on('SIGINT', async () => {
    await gracefulShutdown();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await gracefulShutdown();
    process.exit(0);
  });
}

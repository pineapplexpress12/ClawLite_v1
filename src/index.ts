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
import { autoDiscoverTools, getAllTools } from './tools/sdk/registry.js';
import { getAllTemplates } from './planner/templates.js';
import { complete } from './llm/provider.js';
import { setWorkerExecutor } from './executor/runNode.js';
import { registerWorker, findWorkerForNodeType } from './workers/registry.js';
import { getNode } from './db/nodes.js';
import { getJob } from './db/jobs.js';
import { buildToolContext } from './workers/context.js';
import { WorkspaceAgent } from './workers/WorkspaceAgent.js';
import { ResearchAgent } from './workers/ResearchAgent.js';
import { PublisherAgent } from './workers/PublisherAgent.js';
import { AggregatorAgent } from './workers/AggregatorAgent.js';
import { BuilderAgent } from './workers/BuilderAgent.js';

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

  // 2b. Discover and register tools
  await autoDiscoverTools();
  const tools = getAllTools();
  logger.info('Tools registered', { count: tools.length, names: tools.map(t => t.name) });

  // 2c. Check templates
  const templates = getAllTemplates();
  if (templates.length === 0) {
    logger.warn('No templates loaded — check planner/templates.ts');
  } else {
    logger.info('Templates loaded', { count: templates.length });
  }

  // 2d. Register worker agents
  registerWorker(WorkspaceAgent);
  registerWorker(ResearchAgent);
  registerWorker(PublisherAgent);
  registerWorker(AggregatorAgent);
  registerWorker(BuilderAgent);
  logger.info('Workers registered', {
    count: 5,
    names: ['WorkspaceAgent', 'ResearchAgent', 'PublisherAgent', 'AggregatorAgent', 'BuilderAgent'],
  });

  // 2e. Wire worker executor so template jobs can actually run
  setWorkerExecutor(async (nodeId, jobId) => {
    const node = getNode(nodeId);
    const job = getJob(jobId);
    if (!node || !job) throw new Error(`Node or job not found: ${nodeId}`);

    const worker = findWorkerForNodeType(node.type);
    if (!worker) throw new Error(`No worker for node type: ${node.type}`);

    const toolCtx = buildToolContext(job, node);
    const result = await worker.execute(node, toolCtx);
    return {
      output: (result.output ?? {}) as Record<string, unknown>,
      costTokens: result.costTokens,
    };
  });
  logger.info('Worker executor wired');

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

  // 7. Startup self-test (non-blocking)
  selfTest(config).catch(() => {});

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

async function selfTest(config: any): Promise<void> {
  // Check LLM connectivity
  try {
    const response = await complete({
      model: 'fast',
      messages: [{ role: 'user', content: 'Reply with OK' }],
    });
    logger.info('LLM self-test passed', {
      model: config.llm.tiers.fast,
      tokens: response.usage.total_tokens,
    });
  } catch (err) {
    logger.error('LLM self-test FAILED — check your API key and model config', {
      error: (err as Error).message,
    });
  }

  // Check tools loaded
  const tools = getAllTools();
  if (tools.length === 0) {
    logger.error('No tools loaded — check tools/builtin/ directory');
  }

  // Check templates loaded
  const templates = getAllTemplates();
  if (templates.length === 0) {
    logger.error('No templates loaded — check planner/templates.ts');
  }
}

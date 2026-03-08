# CHANNEL_ADAPTERS.md
## Project: ClawLite
### Multi-Channel Adapter Specification (Telegram, WhatsApp, Discord, Slack)

---

## 1. PURPOSE

The Channel Adapter layer is ClawLite's interface between users and the core runtime. It replaces the previous Telegram-only interface with a channel-agnostic abstraction that supports multiple messaging platforms simultaneously.

This spec defines:
- The unified `ChannelAdapter` interface all channels must implement
- How messages flow from any channel through the shared router
- How approvals, progress updates, and job summaries render per channel
- Channel-specific auth, pairing, and allowlist mechanisms
- How users select and configure channels during onboarding
- Startup, shutdown, and recovery behavior per channel

**Design principle:** The router, executor, workers, memory, and all core systems never reference a specific channel. All platform-specific logic is encapsulated in adapters.

---

## 2. CORE INTERFACE

Every channel adapter must implement this TypeScript interface:

```typescript
interface InboundMessage {
  channelName: string;          // "telegram", "whatsapp", "discord", "slack"
  chatId: string;               // channel-specific chat/conversation ID
  userId: string;               // channel-specific user ID
  text: string;
  timestamp: number;
  replyToMessageId?: string;    // for threaded conversations
  attachments?: Attachment[];   // images, files, audio
  raw: any;                     // original platform message object
}

interface Attachment {
  type: "image" | "audio" | "video" | "document";
  url?: string;
  buffer?: Buffer;
  mimeType: string;
  filename?: string;
}

interface OutboundMessage {
  text: string;
  parseMode?: "markdown" | "html" | "plain";
  replyToMessageId?: string;
}

interface ApprovalRequest {
  approvalId: string;
  actionType: string;
  title: string;
  preview: string;
}

interface ApprovalAction {
  approvalId: string;
  action: "approve" | "reject" | "revise";
  revisionInstructions?: string;
}

interface ChannelAdapter {
  name: string;                              // e.g. "telegram"
  isEnabled(): boolean;                      // check config
  start(): Promise<void>;                    // connect/start polling
  stop(): Promise<void>;                     // graceful disconnect
  getDefaultChatId(): string | null;         // for heartbeat/cron notifications

  // Outbound
  sendMessage(chatId: string, message: OutboundMessage): Promise<string>;  // returns messageId
  sendTypingIndicator(chatId: string): Promise<void>;
  sendApprovalRequest(chatId: string, approval: ApprovalRequest): Promise<void>;
  disableApprovalButtons(chatId: string, messageId: string): Promise<void>;
  sendProgressUpdate(chatId: string, text: string): Promise<void>;

  // Events — adapters emit these, core subscribes
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
  onApprovalAction(handler: (action: ApprovalAction) => Promise<void>): void;
}
```

---

## 3. CHANNEL REGISTRY

Adapters are registered at startup based on config.

```typescript
interface ChannelRegistry {
  register(adapter: ChannelAdapter): void;
  get(name: string): ChannelAdapter | undefined;
  getEnabled(): ChannelAdapter[];
  getDefaultNotificationChannel(): ChannelAdapter;  // first enabled channel
  startAll(): Promise<void>;
  stopAll(): Promise<void>;
}
```

### Startup sequence

```typescript
async function startChannels() {
  const adapters = [
    new TelegramAdapter(config.channels.telegram),
    new WhatsAppAdapter(config.channels.whatsapp),
    new DiscordAdapter(config.channels.discord),
    new SlackAdapter(config.channels.slack),
    new WebChatAdapter(config.channels.webchat),
  ];

  for (const adapter of adapters) {
    if (adapter.isEnabled()) {
      channelRegistry.register(adapter);
    }
  }

  if (channelRegistry.getEnabled().length === 0) {
    throw new Error("No channels enabled. Run `clawlite setup` to configure at least one channel.");
  }

  await channelRegistry.startAll();
}
```

---

## 4. MESSAGE FLOW (CHANNEL-AGNOSTIC)

All channels feed into the same message handler. The core never knows which channel a message came from.

```typescript
// Wire up every enabled channel to the shared handler
for (const adapter of channelRegistry.getEnabled()) {
  adapter.onMessage(async (msg: InboundMessage) => {
    // 1. Auth check — channel-specific allowlist
    if (!isAuthorized(msg.channelName, msg.userId)) {
      await adapter.sendMessage(msg.chatId, { text: "Unauthorized.", parseMode: "plain" });
      return;
    }

    // 2. Store in session for conversational continuity
    db.insertSession({
      chatId: msg.chatId,
      channel: msg.channelName,
      role: "user",
      content: msg.text,
      tokenCount: estimateTokens(msg.text)
    });

    // 3. Check for pending revision
    const pendingRevision = db.getPendingRevision(msg.chatId, msg.channelName);
    if (pendingRevision) {
      db.clearPendingRevision(msg.chatId, msg.channelName);
      await handleRevisionInput(msg, pendingRevision.approvalId);
      return;
    }

    // 4. Route the message
    const intent = await routeMessage(msg.text);

    switch (intent) {
      case "command":
        await handleCommand(msg, adapter);
        break;
      case "chat":
        await handleChat(msg, adapter);
        break;
      case "complex":
        await handleComplex(msg, adapter);
        break;
    }
  });

  adapter.onApprovalAction(async (action: ApprovalAction) => {
    await handleApprovalCallback(action, adapter);
  });
}
```

### Chat handler (channel-agnostic)

```typescript
async function handleChat(msg: InboundMessage, adapter: ChannelAdapter) {
  const budgetCheck = checkDailyBudget(500);
  if (!budgetCheck.ok) {
    await adapter.sendMessage(msg.chatId, {
      text: `⚠️ Daily token budget exhausted (${budgetCheck.remaining} remaining). Resets in ${formatTimeUntilReset()}.`,
      parseMode: "plain"
    });
    return;
  }

  await adapter.sendTypingIndicator(msg.chatId);

  // Get session context for conversational continuity
  const sessionTurns = getSessionContext(msg.chatId, msg.channelName);
  const memoryItems = await memory.retrieve(msg.text ?? "", 3);

  const persona = loadPersona();  // PERSONA.md or config fallback
  const userContext = loadUserContext();  // USER.md if it exists

  const response = await llm.complete({
    model: "fast",
    messages: [
      { role: "system", content: persona + (userContext ? `\n\n## User Context\n${userContext}` : "") },
      ...sessionTurns,
      { role: "user", content: formatChatPrompt(msg.text, memoryItems) }
    ]
  });

  recordTokenUsage(response.usage.total_tokens);

  // Store assistant response in session
  db.insertSession({
    chatId: msg.chatId,
    channel: msg.channelName,
    role: "assistant",
    content: response.text,
    tokenCount: estimateTokens(response.text)
  });

  // Compact session if needed
  await compactSession(msg.chatId, msg.channelName);

  await sendLongMessage(adapter, msg.chatId, response.text);
}
```

### Complex handler (creates a job)

```typescript
async function handleComplex(msg: InboundMessage, adapter: ChannelAdapter) {
  await adapter.sendTypingIndicator(msg.chatId);

  try {
    const { template, slots, confidence } = await selectTemplate(msg.text ?? "", templates);

    // Bounded agentic fallback for low-confidence matches
    if (confidence < 0.7 && confidence >= 0.3) {
      await handleAgenticFallback(msg, adapter);
      return;
    }

    if (confidence < 0.3) {
      await adapter.sendMessage(msg.chatId, {
        text: "I'm not sure what you need. Could you be more specific?",
        parseMode: "plain"
      });
      return;
    }

    const job = await createJobFromTemplate(template, slots, {
      triggerType: "channel_message",
      channel: msg.channelName,
      chatId: msg.chatId,
      dryRun: false
    });

    await adapter.sendMessage(msg.chatId, {
      text: formatJobStarted(job, db.getGraph(job.id).nodes),
      parseMode: "markdown"
    });

    attachProgressListener(job.id, msg.chatId, adapter);
    executeJob(job.id);

  } catch (err: any) {
    if (err instanceof BudgetExhaustedError) {
      await adapter.sendMessage(msg.chatId, {
        text: `⚠️ Daily token budget exhausted (${err.remaining} remaining). Resets in ${formatTimeUntilReset()}.`,
        parseMode: "plain"
      });
    } else {
      await adapter.sendMessage(msg.chatId, {
        text: `❌ Failed to plan job: ${err.message}`,
        parseMode: "plain"
      });
    }
  }
}
```

---

## 5. AUTHORIZATION (PER-CHANNEL)

Each channel has its own allowlist mechanism. Auth is checked before any processing.

```typescript
function isAuthorized(channelName: string, userId: string): boolean {
  const channelConfig = config.channels[channelName];
  if (!channelConfig?.enabled) return false;

  // WhatsApp uses phone numbers, others use platform user IDs
  const allowedIds = channelConfig.allowedUserIds ?? [];

  // Empty allowlist = reject all (fail-closed, not fail-open)
  if (allowedIds.length === 0) return false;

  return allowedIds.includes(userId);
}
```

| Channel | Identifier Type | Example |
|---------|----------------|---------|
| Telegram | Numeric user ID | `123456789` |
| WhatsApp | Phone number | `"14155551234"` |
| Discord | Snowflake user ID | `"987654321098765432"` |
| Slack | Slack user ID | `"U01ABCDEF"` |

---

## 6. APPROVAL SYSTEM (CHANNEL-AGNOSTIC)

Approval requests are sent through the channel adapter. Each channel implements inline buttons/reactions differently, but the core approval flow is identical.

### Sending an approval request

```typescript
async function sendApprovalToChannel(
  chatId: string,
  adapter: ChannelAdapter,
  approvalId: string,
  preview: ApprovalPreview
) {
  await adapter.sendApprovalRequest(chatId, {
    approvalId,
    actionType: preview.actionType,
    title: preview.title,
    preview: truncate(preview.preview, 800)
  });
}
```

### Channel-specific approval rendering

| Channel | Approve/Reject/Revise UX |
|---------|--------------------------|
| Telegram | Inline keyboard buttons |
| WhatsApp | Numbered reply options ("Reply 1 to approve, 2 to reject, 3 to revise") |
| Discord | Reaction emojis (✅ ❌ ✏️) or button components |
| Slack | Block Kit buttons |

Each adapter translates the approval request into its native format and emits `ApprovalAction` events when the user responds.

### Approval callback handling

```typescript
async function handleApprovalCallback(action: ApprovalAction, adapter: ChannelAdapter) {
  const approval = db.getApproval(action.approvalId);
  if (!approval || approval.status !== "pending") return;

  switch (action.action) {
    case "approve":
      db.updateApprovalStatus(action.approvalId, "approved");
      graphEvents.emit(`approval:resolved:${approval.nodeId}`, {
        approvalId: action.approvalId,
        status: "approved",
        payload: approval.payload
      });
      break;

    case "reject":
      db.updateApprovalStatus(action.approvalId, "rejected");
      graphEvents.emit(`approval:resolved:${approval.nodeId}`, {
        approvalId: action.approvalId,
        status: "rejected"
      });
      break;

    case "revise":
      db.updateApprovalStatus(action.approvalId, "revision_requested");
      const job = db.getJobByNodeId(approval.nodeId);
      await adapter.sendMessage(job.chatId, {
        text: "✏️ What would you like to change? Reply with your revision instructions.",
        parseMode: "plain"
      });
      db.setPendingRevision(job.chatId, job.channel, action.approvalId);
      break;
  }
}
```

---

## 7. PROGRESS UPDATES

The executor emits progress events. The channel layer listens and forwards them through the correct adapter.

```typescript
function attachProgressListener(jobId: string, chatId: string, adapter: ChannelAdapter) {
  let lastUpdateAt = 0;
  const MIN_INTERVAL = 3000;

  graphEvents.on(`progress:${jobId}`, async (event: ProgressEvent) => {
    const now = Date.now();

    switch (event.type) {
      case "node_started":
        if (now - lastUpdateAt > MIN_INTERVAL) {
          await adapter.sendProgressUpdate(chatId, `⚙️ ${event.nodeTitle} — ${event.agentName} working...`);
          lastUpdateAt = now;
        }
        break;

      case "node_completed":
        await adapter.sendProgressUpdate(chatId, `✅ ${event.nodeTitle}\n${event.summary}`);
        lastUpdateAt = now;
        break;

      case "node_failed":
        const retry = event.willRetry ? " (retrying...)" : " (failed)";
        await adapter.sendProgressUpdate(chatId, `⚠️ ${event.nodeTitle}${retry}\n${event.reason}`);
        break;

      case "approval_needed":
        await sendApprovalToChannel(chatId, adapter, event.approvalId, event.preview);
        break;

      case "circuit_breaker":
        await adapter.sendMessage(chatId, {
          text: `🛑 Job killed by circuit breaker\nReason: ${event.reason}`,
          parseMode: "plain"
        });
        break;

      case "job_completed":
        // Include artifact link if available
        const artifactLink = event.artifactId
          ? `\n\n📎 Full report: http://${config.http.host}:${config.http.port}/artifacts/${event.artifactId}`
          : "";
        await adapter.sendMessage(chatId, {
          text: `✅ Job Complete\n\n${event.summary}${artifactLink}`,
          parseMode: "markdown"
        });
        break;

      case "job_failed":
        await adapter.sendMessage(chatId, {
          text: `❌ Job failed\n${event.reason}`,
          parseMode: "plain"
        });
        break;
    }
  });
}
```

---

## 8. TELEGRAM ADAPTER

### Authentication
- Bot token from `config.channels.telegram.botToken`
- User allowlist from `config.channels.telegram.allowedUserIds` (numeric Telegram user IDs)

### Connection
- Long polling via `node-telegram-bot-api` (no webhook required)
- Poll interval: 1 second
- Long polling timeout: 10 seconds

### Approvals
- Inline keyboard buttons (Approve / Reject / Revise)
- Callback queries handled via `bot.on("callback_query")`
- Buttons disabled after tap to prevent double-action

### Message limits
- 4096 characters per message — auto-split longer messages

### Implementation

```typescript
class TelegramAdapter implements ChannelAdapter {
  name = "telegram";
  private bot: TelegramBot;
  private messageHandlers: ((msg: InboundMessage) => Promise<void>)[] = [];
  private approvalHandlers: ((action: ApprovalAction) => Promise<void>)[] = [];

  constructor(private channelConfig: TelegramChannelConfig) {
    this.bot = new TelegramBot(channelConfig.botToken, {
      polling: { interval: 1000, autoStart: false, params: { timeout: 10 } }
    });
  }

  isEnabled(): boolean {
    return this.channelConfig.enabled && !!this.channelConfig.botToken;
  }

  async start(): Promise<void> {
    this.bot.startPolling();

    this.bot.on("message", async (msg) => {
      const inbound: InboundMessage = {
        channelName: "telegram",
        chatId: String(msg.chat.id),
        userId: String(msg.from?.id ?? 0),
        text: msg.text ?? "",
        timestamp: msg.date * 1000,
        raw: msg
      };
      for (const handler of this.messageHandlers) {
        await handler(inbound);
      }
    });

    this.bot.on("callback_query", async (query) => {
      const data = query.data ?? "";
      const [action, approvalId] = data.split(":");

      await this.bot.answerCallbackQuery(query.id);
      await this.bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: query.message?.chat.id, message_id: query.message?.message_id }
      );

      if (["approve", "reject", "revise"].includes(action)) {
        for (const handler of this.approvalHandlers) {
          await handler({ approvalId, action: action as any });
        }
      }
    });
  }

  async stop(): Promise<void> {
    await this.bot.stopPolling();
  }

  getDefaultChatId(): string | null {
    return this.channelConfig.allowedUserIds?.[0]
      ? String(this.channelConfig.allowedUserIds[0])
      : null;
  }

  async sendMessage(chatId: string, message: OutboundMessage): Promise<string> {
    const parseMode = message.parseMode === "markdown" ? "Markdown" : undefined;
    const result = await sendWithRetry(() =>
      this.bot.sendMessage(Number(chatId), message.text, { parse_mode: parseMode })
    );
    return String(result.message_id);
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    await this.bot.sendChatAction(Number(chatId), "typing");
  }

  async sendApprovalRequest(chatId: string, approval: ApprovalRequest): Promise<void> {
    const icon = getApprovalIcon(approval.actionType);
    const text = `${icon} Approval Required\nAction: ${approval.title}\n\n${approval.preview}\n\nApprove this action?`;

    await this.bot.sendMessage(Number(chatId), text, {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Approve", callback_data: `approve:${approval.approvalId}` },
          { text: "❌ Reject", callback_data: `reject:${approval.approvalId}` },
          { text: "✏️ Revise", callback_data: `revise:${approval.approvalId}` }
        ]]
      }
    });
  }

  async disableApprovalButtons(chatId: string, messageId: string): Promise<void> {
    await this.bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: Number(chatId), message_id: Number(messageId) }
    );
  }

  async sendProgressUpdate(chatId: string, text: string): Promise<void> {
    await this.sendMessage(chatId, { text, parseMode: "markdown" });
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  onApprovalAction(handler: (action: ApprovalAction) => Promise<void>): void {
    this.approvalHandlers.push(handler);
  }
}
```

---

## 9. WHATSAPP ADAPTER

### Authentication
- QR code pairing via `@whiskeysockets/baileys`
- Credentials stored in `.clawlite/sessions/whatsapp/`
- Phone number allowlist from `config.channels.whatsapp.allowedPhoneNumbers`

### Connection
- WebSocket connection via Baileys (persistent, auto-reconnect)
- Multi-device support (no phone needed to stay online after pairing)

### Approvals
- Numbered text replies: "Reply 1 to approve, 2 to reject, 3 to revise"
- The adapter tracks which approval is pending per chat and maps reply numbers to actions

```typescript
// WhatsApp doesn't have inline buttons, so approvals use numbered replies
async sendApprovalRequest(chatId: string, approval: ApprovalRequest): Promise<void> {
  const icon = getApprovalIcon(approval.actionType);
  const text = [
    `${icon} *Approval Required*`,
    `*Action:* ${approval.title}`,
    ``,
    approval.preview,
    ``,
    `Reply with:`,
    `*1* — ✅ Approve`,
    `*2* — ❌ Reject`,
    `*3* — ✏️ Revise`,
  ].join("\n");

  await this.sock.sendMessage(chatId, { text });

  // Store pending approval state so the next numeric reply maps to an action
  db.setPendingApprovalChoice(chatId, "whatsapp", approval.approvalId);
}
```

### Message limits
- 65,536 characters per message — rarely an issue, but split at 4000 for readability

### Pairing flow (during onboarding)

```text
=== WhatsApp Setup ===
Starting WhatsApp pairing...
Scan this QR code with your WhatsApp app:

  ██████████████████████████
  ██                      ██
  ██  QR CODE RENDERED    ██
  ██  IN TERMINAL         ██
  ██                      ██
  ██████████████████████████

✓ Paired successfully.
Enter allowed phone numbers (comma-separated, with country code):
  > 14155551234, 14155559876
✓ WhatsApp configured.
```

---

## 10. DISCORD ADAPTER

### Authentication
- Bot token from `config.channels.discord.botToken`
- User ID allowlist from `config.channels.discord.allowedUserIds` (Discord snowflake IDs)
- Bot must be invited to server with appropriate permissions

### Connection
- WebSocket via `discord.js` client
- Auto-reconnect on disconnect

### Approvals
- Button components (Discord's MessageActionRow with Buttons)
- Interaction handlers for button clicks

```typescript
async sendApprovalRequest(chatId: string, approval: ApprovalRequest): Promise<void> {
  const channel = await this.client.channels.fetch(chatId);
  if (!channel?.isTextBased()) return;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`approve:${approval.approvalId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`reject:${approval.approvalId}`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`revise:${approval.approvalId}`).setLabel("✏️ Revise").setStyle(ButtonStyle.Secondary)
  );

  await channel.send({ content: formatApprovalText(approval), components: [row] });
}
```

### Message limits
- 2000 characters per message — auto-split with embeds for longer content

### DM vs Server mode
- DM mode: bot responds to direct messages from allowed users
- Server mode: bot responds to mentions or in a designated channel

---

## 11. SLACK ADAPTER

### Authentication
- Bot token + app-level token from `config.channels.slack`
- User ID allowlist from `config.channels.slack.allowedUserIds` (Slack user IDs)

### Connection
- Socket mode via `@slack/bolt` (no public URL needed, like polling)

### Approvals
- Block Kit with interactive buttons
- Action handlers for button clicks

```typescript
async sendApprovalRequest(chatId: string, approval: ApprovalRequest): Promise<void> {
  await this.app.client.chat.postMessage({
    channel: chatId,
    text: `${approval.title} — Approval Required`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${approval.title}*\n${approval.preview}` } },
      {
        type: "actions",
        elements: [
          { type: "button", text: { type: "plain_text", text: "✅ Approve" }, action_id: `approve:${approval.approvalId}`, style: "primary" },
          { type: "button", text: { type: "plain_text", text: "❌ Reject" }, action_id: `reject:${approval.approvalId}`, style: "danger" },
          { type: "button", text: { type: "plain_text", text: "✏️ Revise" }, action_id: `revise:${approval.approvalId}` }
        ]
      }
    ]
  });
}
```

### Message limits
- 40,000 characters per message with Block Kit — use blocks for structured output

---

## 12. WEBCHAT ADAPTER (BUILT-IN WEB UI)

The WebChat adapter provides a browser-based interface served by ClawLite's built-in Fastify HTTP server. This is for users who don't want to use an external messaging app, or who prefer a richer UI for reviewing artifacts, managing approvals, and monitoring jobs.

### Why WebChat matters

Not everyone wants to run an AI operator through Telegram or WhatsApp. Some use cases are better served by a proper web interface: reviewing long research reports inline, seeing job progress in real time with a dashboard, managing multiple pending approvals, or just preferring a desktop browser tab over a phone app. WebChat is also the zero-dependency option — no bot tokens, no QR codes, no third-party accounts needed.

### Architecture

WebChat uses the same Fastify HTTP server already running for webhooks and artifacts (default port 18790). It adds:

1. **A static SPA** served at `http://localhost:18790/chat` — a single-page app with a chat interface, job sidebar, and approval panel
2. **A WebSocket endpoint** at `ws://localhost:18790/ws` — real-time bidirectional communication for messages, progress events, and approval actions
3. **The same `ChannelAdapter` interface** — WebChat is just another channel, the core runtime doesn't know or care that it's a browser

### Connection

- WebSocket from the browser to the Fastify server
- Auth via a session token (generated on first connect, stored in localStorage)
- Local-only by default (`127.0.0.1`) — remote access requires SSH tunnel or Tailscale, same as OpenClaw's approach

### Config

```json
{
  "channels": {
    "webchat": {
      "enabled": true,
      "authToken": "auto-generated-on-setup"
    }
  }
}
```

When `webchat` is enabled, the onboarding wizard generates a random auth token and prints the URL:

```text
=== WebChat Setup ===
✓ WebChat enabled at http://localhost:18790/chat
✓ Auth token: clw_abc123... (saved to config)
Open this URL in your browser to start chatting.
```

### WebSocket protocol

```typescript
// Client → Server
interface WSClientMessage {
  type: "connect" | "message" | "approval_action";
  token?: string;           // auth token (on connect)
  text?: string;            // chat message
  approvalId?: string;      // for approval actions
  action?: "approve" | "reject" | "revise";
  revisionInstructions?: string;
}

// Server → Client
interface WSServerMessage {
  type: "connected" | "message" | "typing" | "progress" | "approval_request" | "job_started" | "job_completed" | "job_failed" | "error";
  text?: string;
  jobId?: string;
  approval?: ApprovalRequest;
  progress?: ProgressEvent;
}
```

### Implementation

```typescript
class WebChatAdapter implements ChannelAdapter {
  name = "webchat";
  private clients: Map<string, WebSocket> = new Map();  // chatId → ws connection
  private messageHandlers: ((msg: InboundMessage) => Promise<void>)[] = [];
  private approvalHandlers: ((action: ApprovalAction) => Promise<void>)[] = [];

  constructor(private channelConfig: WebChatChannelConfig) {}

  isEnabled(): boolean {
    return this.channelConfig.enabled;
  }

  async start(): Promise<void> {
    // Register WebSocket upgrade on existing Fastify server
    fastify.register(async (fastify) => {
      fastify.get('/ws', { websocket: true }, (socket, req) => {
        // Auth on first message
        socket.on('message', async (raw: string) => {
          const msg = JSON.parse(raw);

          if (msg.type === "connect") {
            if (msg.token !== this.channelConfig.authToken) {
              socket.send(JSON.stringify({ type: "error", text: "Unauthorized" }));
              socket.close();
              return;
            }
            const chatId = `webchat_${Date.now()}`;
            this.clients.set(chatId, socket);
            socket.send(JSON.stringify({ type: "connected", chatId }));

            socket.on('close', () => this.clients.delete(chatId));
            return;
          }

          // Find chatId for this socket
          const chatId = [...this.clients.entries()].find(([_, ws]) => ws === socket)?.[0];
          if (!chatId) return;

          if (msg.type === "message" && msg.text) {
            const inbound: InboundMessage = {
              channelName: "webchat",
              chatId,
              userId: "webchat_user",  // single-user, no multi-user for MVP
              text: msg.text,
              timestamp: Date.now(),
              raw: msg
            };
            for (const handler of this.messageHandlers) {
              await handler(inbound);
            }
          }

          if (msg.type === "approval_action") {
            for (const handler of this.approvalHandlers) {
              await handler({
                approvalId: msg.approvalId!,
                action: msg.action as any,
                revisionInstructions: msg.revisionInstructions
              });
            }
          }
        });
      });
    });

    // Serve the static SPA
    fastify.get('/chat', async (req, reply) => {
      return reply.type('text/html').send(getWebChatHTML());
    });

    // Serve static assets for the chat UI
    fastify.register(require('@fastify/static'), {
      root: path.join(__dirname, 'webchat/static'),
      prefix: '/chat/static/'
    });
  }

  async stop(): Promise<void> {
    for (const [_, ws] of this.clients) {
      ws.close();
    }
    this.clients.clear();
  }

  getDefaultChatId(): string | null {
    // Return the first connected client, or null
    const first = this.clients.keys().next().value;
    return first ?? null;
  }

  async sendMessage(chatId: string, message: OutboundMessage): Promise<string> {
    const ws = this.clients.get(chatId);
    if (!ws) return "";
    const msgId = `msg_${Date.now()}`;
    ws.send(JSON.stringify({ type: "message", text: message.text, id: msgId }));
    return msgId;
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    const ws = this.clients.get(chatId);
    if (!ws) return;
    ws.send(JSON.stringify({ type: "typing" }));
  }

  async sendApprovalRequest(chatId: string, approval: ApprovalRequest): Promise<void> {
    const ws = this.clients.get(chatId);
    if (!ws) return;
    ws.send(JSON.stringify({ type: "approval_request", approval }));
  }

  async disableApprovalButtons(chatId: string, messageId: string): Promise<void> {
    // The web UI handles button state client-side after action is taken
  }

  async sendProgressUpdate(chatId: string, text: string): Promise<void> {
    const ws = this.clients.get(chatId);
    if (!ws) return;
    ws.send(JSON.stringify({ type: "progress", text }));
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  onApprovalAction(handler: (action: ApprovalAction) => Promise<void>): void {
    this.approvalHandlers.push(handler);
  }
}
```

### Web UI features

The SPA served at `/chat` provides:

- **Chat panel** — send messages, see responses with markdown rendering, conversational history
- **Job sidebar** — list active and recent jobs, click to see node-by-node progress
- **Approval panel** — pending approvals with Approve/Reject/Revise buttons and full preview
- **Artifact viewer** — inline rendering of research reports, draft emails, generated content (no need to open a separate URL)
- **Status bar** — daily budget remaining, active job count, channel status, last heartbeat

The web UI is a **lightweight static SPA** — HTML + CSS + vanilla JS (or a minimal framework like Preact). It does NOT require a build step, npm install, or any frontend toolchain. It ships as static files bundled with ClawLite.

### Approvals in WebChat

Approvals render as rich cards with buttons directly in the chat interface:

```
┌──────────────────────────────────────┐
│ 📧 Approval Required                 │
│                                      │
│ Action: Send email to client@co.com  │
│                                      │
│ Subject: Onboarding timeline update  │
│ Body: Hi John, following up on...    │
│                                      │
│ [✅ Approve] [❌ Reject] [✏️ Revise] │
└──────────────────────────────────────┘
```

### Message limits
- No hard character limit (it's a browser) — but long content should use the artifact viewer for readability

### Security

- **Local-only by default** — Fastify binds to `127.0.0.1`, not `0.0.0.0`
- **Auth token required** — WebSocket connection must provide the correct token on connect
- **No public exposure** — for remote access, use SSH tunnel (`ssh -N -L 18790:127.0.0.1:18790 user@vps`) or Tailscale
- **Single-user for MVP** — no multi-user sessions, no user management

---

## 13. LONG MESSAGE HANDLING

Each channel has different message length limits. A shared utility splits messages appropriately.

```typescript
async function sendLongMessage(
  adapter: ChannelAdapter,
  chatId: string,
  text: string,
  parseMode?: "markdown" | "html" | "plain"
) {
  const maxLength = getChannelMaxLength(adapter.name);

  if (text.length <= maxLength) {
    await adapter.sendMessage(chatId, { text, parseMode });
    return;
  }

  // Split at paragraph boundaries when possible
  const chunks = splitAtBoundaries(text, maxLength);
  for (const chunk of chunks) {
    await adapter.sendMessage(chatId, { text: chunk, parseMode });
  }
}

function getChannelMaxLength(channelName: string): number {
  switch (channelName) {
    case "telegram": return 4096;
    case "whatsapp": return 4000;
    case "discord": return 2000;
    case "slack": return 3000;
    case "webchat": return 50000;  // browser has no real limit, but chunk for UX
    default: return 2000;
  }
}
```

---

## 14. ERROR HANDLING & EDGE CASES

| Scenario | Behavior |
|----------|----------|
| Channel disconnects mid-job | Job continues; updates queue until reconnect |
| Message too long | Split per channel limits |
| Markdown parse error | Retry with `parseMode: "plain"` |
| Rate limit (any channel) | Exponential backoff, retry up to 5 times |
| Approval button tapped twice | Second tap gets "already resolved" response |
| Approval expires (24h) | Node auto-cancelled, user notified |
| Runtime restarted mid-approval | On restart, re-send approval messages for `waiting_approval` nodes |
| User sends message mid-job | Queue it; process after current job or allow parallel per config |
| Circuit breaker tripped | Job killed, user notified via originating channel |
| WhatsApp credential expires | Auto-reconnect; if fails, log error and prompt re-pairing |

### Retry wrapper (shared across channels)

```typescript
async function sendWithRetry(
  fn: () => Promise<any>,
  maxRetries = 5,
  baseDelayMs = 1000
) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const statusCode = err?.response?.statusCode ?? err?.status ?? 0;
      if (statusCode === 429 || statusCode >= 500) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
  throw new Error("Max retries exceeded");
}
```

---

## 15. RESTART RECOVERY

On ClawLite startup, re-attach to any interrupted jobs across all channels.

```typescript
async function recoverChannelState() {
  const activeJobs = db.getJobsByStatus(["running", "waiting_approval", "queued"]);

  for (const job of activeJobs) {
    if (!job.chatId || !job.channel) continue;

    const adapter = channelRegistry.get(job.channel);
    if (!adapter) {
      logger.warn(`Job ${job.id} used channel ${job.channel} which is no longer enabled`);
      continue;
    }

    attachProgressListener(job.id, job.chatId, adapter);

    // Re-send approval requests for nodes still waiting
    const waitingNodes = db.getNodesByStatus(job.id, "waiting_approval");
    for (const node of waitingNodes) {
      const approval = db.getPendingApprovalByNodeId(node.id);
      if (approval && approval.status === "pending") {
        await adapter.sendApprovalRequest(job.chatId, {
          approvalId: approval.id,
          actionType: approval.actionType,
          title: approval.title,
          preview: approval.preview
        });
      }
    }

    await adapter.sendMessage(job.chatId, {
      text: `🔄 Reconnected to job ${job.id.slice(0, 8)} — resuming...`,
      parseMode: "plain"
    });
  }
}
```

---

## 16. DATABASE ADDITIONS

**jobs table — updated columns:**
```sql
channel    TEXT     -- "telegram", "whatsapp", "discord", "slack"
chat_id    TEXT     -- channel-specific chat ID (was INTEGER, now TEXT for cross-platform)
```

**pending_revisions table:**
```sql
id           TEXT PRIMARY KEY
chat_id      TEXT
channel      TEXT
approval_id  TEXT
created_at   INTEGER
```

**pending_approval_choices table (WhatsApp numbered replies):**
```sql
chat_id      TEXT
channel      TEXT
approval_id  TEXT
created_at   INTEGER
PRIMARY KEY (chat_id, channel)
```

---

## 17. ONBOARDING: CHANNEL SELECTION

During `clawlite setup`, users select one or more channels:

```text
Step 4: Messaging Channels
  Select one or more channels for ClawLite:
    [ ] Telegram  — Bot token, easy setup
    [ ] WhatsApp  — QR code pairing, personal number
    [ ] Discord   — Bot token, server or DM
    [ ] Slack     — Bot + app token, workspace
  > (use arrow keys, space to select, enter to confirm)

  You selected: Telegram, WhatsApp

  === Telegram Setup ===
  Enter your Telegram bot token: 123456:ABC...
  Enter your Telegram user ID (for allowlist): 123456789
  ✓ Bot connected.

  === WhatsApp Setup ===
  Starting WhatsApp pairing...
  Scan this QR code with WhatsApp:
  [QR code renders in terminal]
  ✓ Paired successfully.
  Enter allowed phone numbers (with country code): 14155551234
  ✓ WhatsApp configured.
```

Channel libraries are only installed for selected channels to keep the dependency footprint small.

---

## 18. STARTUP SEQUENCE (UPDATED)

```typescript
async function startClawLite() {
  // 1. Initialize database (with FTS5)
  await db.initialize();

  // 2. Load PERSONA.md / USER.md
  loadIdentityFiles();

  // 3. Load template library
  await templates.loadAll();

  // 4. Register tools (with hot-loading watcher)
  await toolRegistry.loadAll();
  toolRegistry.watchCustomTools();

  // 5. Register workers
  workerRegistry.loadAll();

  // 6. Start all enabled channels
  await channelRegistry.startAll();
  logger.info(`[ClawLite] ${config.operator.name} is online on: ${channelRegistry.getEnabled().map(c => c.name).join(", ")}`);

  // 7. Start Fastify HTTP server
  await startHTTPServer();

  // 8. Recover any interrupted jobs
  await recoverChannelState();
  recoverCrashedJobs();

  // 9. Start heartbeat scheduler
  if (config.heartbeat.enabled) {
    startHeartbeat(config.heartbeat.intervalMinutes);
  }

  logger.info(`[ClawLite] Recovery complete. Ready.`);
}

startClawLite().catch(console.error);
```

---

## 19. MINIMUM CODE MODULES

```text
/channels/types.ts                  — ChannelAdapter, InboundMessage, OutboundMessage interfaces
/channels/registry.ts               — ChannelRegistry implementation
/channels/shared/auth.ts            — Cross-channel authorization
/channels/shared/longMessage.ts     — Message splitting utility
/channels/shared/retry.ts           — sendWithRetry()
/channels/shared/approval.ts        — Channel-agnostic approval flow
/channels/shared/progress.ts        — attachProgressListener()
/channels/shared/recovery.ts        — recoverChannelState()
/channels/adapters/telegram.ts      — TelegramAdapter
/channels/adapters/whatsapp.ts      — WhatsAppAdapter
/channels/adapters/discord.ts       — DiscordAdapter
/channels/adapters/slack.ts         — SlackAdapter
/channels/adapters/webchat.ts       — WebChatAdapter (built-in web UI)
/channels/webchat/static/           — SPA HTML/CSS/JS for browser UI
/channels/handlers/message.ts       — Shared message handler (routes to chat/command/complex)
/channels/handlers/chat.ts          — Chat path with session context
/channels/handlers/complex.ts       — Complex path with template selection + agentic fallback
/channels/handlers/commands.ts      — Slash command handlers
```

---

## 20. ADDING NEW CHANNELS (v2+)

To add a new channel (e.g., Signal, iMessage, Matrix):

1. Create a new file in `/channels/adapters/signal.ts`
2. Implement the `ChannelAdapter` interface
3. Add a config block to `config.json` schema
4. Register in the startup channel list
5. No changes to router, executor, workers, or any core system

This is the key architectural win of the adapter layer — the core is completely channel-agnostic.

---

*The six core spec files are:*
- *`CLAWSPEC.md` — system overview, router, tiering, circuit breakers, heartbeat, sessions, HTTP server*
- *`TASKGRAPH_ENGINE.md` — template graphs, DAG executor, bounded agentic fallback, hard limits*
- *`CHANNEL_ADAPTERS.md` — this file, multi-channel abstraction, per-channel implementations*
- *`TOOL_SDK.md` — tool/plugin architecture, dry run support, hot-loading*
- *`WORKER_AGENTS.md` — MVP 4 agents, model-aware execution, agent profiles*
- *~~`TELEGRAM_INTERFACE.md`~~ — superseded by `CHANNEL_ADAPTERS.md`*

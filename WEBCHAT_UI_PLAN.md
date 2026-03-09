# WEBCHAT_UI_PLAN.md — ClawLite Web Interface Redesign
## Copy this entire file to Claude Code as instructions

---

## PROBLEM

The current webchat at `/chat` is a 159-line minimal chat box — plain text input, plain text output, no formatting, no sidebar, no system information, no file uploads, no markdown rendering, no job tracking. It looks like a 2010 chatroom, not a 2026 AI operator dashboard.

OpenClaw's web interface has: a Control UI dashboard with agent management, conversation history, channel monitoring, system health, cost tracking, tool catalogs, and streaming responses with proper formatting. Community dashboards add real-time token monitoring, cost analysis, cron job status, and sub-agent tracking.

ClawLite's webchat needs to be a proper **operator command center** — not just a chat window.

---

## TARGET DESIGN

A single-page app with three columns on desktop (collapsible to one on mobile):

```
┌─────────────────────────────────────────────────────────────────────────┐
│  🦞 Harri — ClawLite                    ◉ Online    ⚙️ Settings       │
├──────────────────┬──────────────────────────────────┬───────────────────┤
│                  │                                  │                   │
│  SIDEBAR LEFT    │     MAIN CHAT AREA               │  SIDEBAR RIGHT    │
│  (240px)         │     (flex)                        │  (280px)          │
│                  │                                  │                   │
│  Sub-Agents      │  [chat messages with             │  System Status    │
│  ──────────      │   markdown rendering,            │  ──────────       │
│  🟢 inbox   12K  │   code blocks, links,            │  Budget: 38%      │
│  🟢 calendar 4K  │   inline artifacts,              │  ████░░░░ 76K     │
│  🟢 content 24K  │   approval cards,                │                   │
│  🟢 invoicing 9K │   progress indicators,           │  Active Jobs      │
│                  │   file previews]                 │  ──────────       │
│  Recent Jobs     │                                  │  ⚙️ inbox check   │
│  ──────────      │                                  │  ✅ tweet draft   │
│  ✅ Inbox check  │                                  │                   │
│  ✅ Tweets posted│                                  │  Tools            │
│  ⚙️ Research...  │                                  │  ──────────       │
│                  │                                  │  workspace ✅     │
│  Quick Actions   │                                  │  research ✅      │
│  ──────────      │                                  │  config ✅        │
│  📧 Check Inbox  │                                  │                   │
│  📅 Today's Cal  │                                  │  Heartbeat        │
│  🔍 Research     │                                  │  ──────────       │
│  🤖 Build Agent  │                                  │  Next: 18m        │
│                  │                                  │  Last: none       │
│                  │                                  │                   │
├──────────────────┴──────────────────────────────────┴───────────────────┤
│  [📎 Upload]  [Type a message or /command...]              [Send ▶]    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## REQUIREMENTS

### 1. Layout — Three-Column Dashboard

- **Left sidebar (240px, collapsible):**
  - Sub-agent list with status indicators (🟢 active, 🟡 paused, ⚪ disabled) and today's token count
  - Recent jobs list (last 10) with status icons (✅ completed, ⚙️ running, ❌ failed, ⏳ waiting approval)
  - Quick action buttons that send predefined commands (/inbox, /today, /research, /build)
  - Collapsible on mobile — hamburger menu icon

- **Main chat area (flex, fills remaining width):**
  - Full conversation with markdown rendering
  - Code blocks with syntax highlighting
  - Inline approval cards with Approve/Reject/Revise buttons
  - Progress indicators for running jobs (animated)
  - File previews for uploaded/generated files (images inline, PDFs as download links)
  - Artifact cards with "View Full" links to the artifact viewer
  - Typing indicator with agent name
  - Auto-scroll to bottom on new messages (with "scroll to bottom" button if user scrolled up)

- **Right sidebar (280px, collapsible):**
  - System status: connection state, uptime
  - Budget widget: visual progress bar, tokens consumed/remaining, estimated cost today, reset countdown
  - Active jobs: currently running jobs with node-by-node progress
  - Installed tools: list with status and security scores
  - Heartbeat: next check time, last result
  - Collapsible on mobile

- **Input area (bottom, full width):**
  - Text input with auto-resize (grows with content, max 4 lines)
  - File upload button (opens file picker, supports drag-and-drop)
  - Send button
  - Keyboard shortcut: Enter to send, Shift+Enter for new line
  - Command autocomplete: typing `/` shows a dropdown of available commands

### 2. Markdown Rendering

The current UI renders plain text. Bot responses need proper markdown:

- **Headers** (##, ###) rendered as styled headings
- **Bold** and *italic* rendered correctly
- **Code blocks** with syntax highlighting (use highlight.js from CDN)
- **Inline code** with monospace background
- **Links** clickable, open in new tab
- **Lists** (bullet and numbered) properly indented
- **Tables** rendered as HTML tables (the agent outputs tables for status/budget/jobs)

Use a lightweight markdown library loaded from CDN:
```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.0/marked.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
```

### 3. Approval Cards

When the agent requests approval, render a rich card instead of plain text:

```html
<div class="approval-card">
  <div class="approval-icon">📧</div>
  <div class="approval-content">
    <h3>Approval Required</h3>
    <p class="approval-action">Send email to sarah@brandedgroup.com</p>
    <div class="approval-preview">
      <pre>Subject: W-9 Form — 305 Locksmith LLC

Hi Sarah,
Attached is our updated W-9...</pre>
    </div>
    <div class="approval-actions">
      <button class="btn-approve" onclick="sendApproval('id', 'approve')">✅ Approve</button>
      <button class="btn-reject" onclick="sendApproval('id', 'reject')">❌ Reject</button>
      <button class="btn-revise" onclick="startRevise('id')">✏️ Revise</button>
    </div>
  </div>
</div>
```

### 4. Job Progress Cards

When a job is running, show real-time progress inline in chat:

```html
<div class="job-card">
  <div class="job-header">
    <span class="job-icon">🚀</span>
    <span class="job-title">Inbox Check</span>
    <span class="job-id">a3f2c1d8</span>
  </div>
  <div class="job-steps">
    <div class="step completed">✅ Fetch unread emails</div>
    <div class="step running">⚙️ Summarize threads <span class="spinner"></span></div>
    <div class="step pending">⏳ Format response</div>
  </div>
  <div class="job-meta">3/5 steps · 12,340 tokens · 45s</div>
</div>
```

Job cards update in real-time via WebSocket events.

### 5. File Upload

- Drag-and-drop zone on the chat area (highlight border when dragging)
- File upload button (📎 icon) next to the input
- Preview before sending: thumbnail for images, filename/size for documents
- Upload via multipart POST to `/upload` endpoint
- Show upload progress bar

```javascript
// Drag and drop
const chatArea = document.getElementById('chat');
chatArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  chatArea.classList.add('drag-over');
});
chatArea.addEventListener('drop', async (e) => {
  e.preventDefault();
  chatArea.classList.remove('drag-over');
  const files = e.dataTransfer.files;
  for (const file of files) {
    await uploadFile(file);
  }
});

async function uploadFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('chatId', chatId);
  
  const response = await fetch('/upload', { method: 'POST', body: formData });
  const result = await response.json();
  
  // Show file in chat
  addFileMessage(file.name, file.type, file.size, result.artifactId);
  
  // Notify via WebSocket that a file was uploaded
  ws.send(JSON.stringify({ 
    type: 'message', 
    chatId, 
    text: `[Uploaded: ${file.name}]`,
    attachmentId: result.artifactId 
  }));
}
```

### 6. Command Autocomplete

When the user types `/`, show a dropdown of available commands:

```javascript
input.addEventListener('input', () => {
  const text = input.value;
  if (text.startsWith('/') && text.length > 1) {
    const query = text.slice(1).toLowerCase();
    const matches = COMMANDS.filter(c => c.name.includes(query));
    showAutocomplete(matches);
  } else {
    hideAutocomplete();
  }
});

const COMMANDS = [
  { name: 'inbox', description: 'Check unread emails', icon: '📧' },
  { name: 'today', description: "Today's calendar", icon: '📅' },
  { name: 'draft', description: 'Draft an email', icon: '✉️' },
  { name: 'research', description: 'Research a topic', icon: '🔍' },
  { name: 'status', description: 'System status', icon: '📊' },
  { name: 'budget', description: 'Token budget', icon: '💰' },
  { name: 'agents', description: 'List sub-agents', icon: '🤖' },
  { name: 'tools', description: 'List installed tools', icon: '🔧' },
  { name: 'build', description: 'Build new capability', icon: '🏗️' },
  { name: 'remember', description: 'Save a fact', icon: '💡' },
  { name: 'forget', description: 'Remove a fact', icon: '🗑️' },
  { name: 'profile', description: 'Your profile', icon: '👤' },
  { name: 'heartbeat', description: 'Heartbeat checks', icon: '💓' },
  { name: 'help', description: 'All commands', icon: '❓' },
];
```

### 7. Real-Time Sidebar Updates

The sidebars fetch data via the WebSocket and HTTP API:

```javascript
// On connect, request system status
ws.send(JSON.stringify({ type: 'request_status' }));

// Periodically refresh (every 30 seconds)
setInterval(() => {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'request_status' }));
  }
}, 30000);

// Also fetch from HTTP API as fallback
async function fetchStatus() {
  const res = await fetch('/status');
  const data = await res.json();
  updateBudgetWidget(data.dailyBudget);
  updateAgentList(data.subAgents);
  updateJobList(data.recentJobs);
  updateToolList(data.tools);
  updateHeartbeat(data.lastHeartbeat);
}
```

**The WebSocket adapter needs to be updated to handle `request_status` messages** and respond with the current system state. Add this to `webchat.ts`:

```typescript
if (msg.type === 'request_status') {
  // Fetch status data and send back
  const status = getSystemStatus(); // from http/status.ts
  socket.send(JSON.stringify({ type: 'status_update', ...status }));
}
```

### 8. Theme — Dark Mode Default

Dark theme with blue accents (similar to OpenClaw's dark aesthetic but cleaner):

```css
:root {
  --bg-primary: #0f0f14;
  --bg-secondary: #1a1a24;
  --bg-tertiary: #22222e;
  --bg-hover: #2a2a38;
  --text-primary: #e4e4e7;
  --text-secondary: #a1a1aa;
  --text-muted: #71717a;
  --accent: #3b82f6;
  --accent-hover: #2563eb;
  --success: #22c55e;
  --warning: #f59e0b;
  --danger: #ef4444;
  --border: #2e2e3a;
  --sidebar-width: 240px;
  --right-sidebar-width: 280px;
}
```

User messages: accent color bubble (right-aligned).
Bot messages: dark secondary background (left-aligned) with full markdown rendering.
System messages: muted, centered, small text.
Approval cards: warning-colored border with action buttons.
Job cards: tertiary background with animated progress.

### 9. Responsive / Mobile

On screens < 768px:
- Both sidebars collapse to hidden
- Hamburger menu (top-left) toggles left sidebar as overlay
- Info button (top-right) toggles right sidebar as overlay
- Chat area fills full width
- Input area stays fixed at bottom

On screens 768-1200px:
- Left sidebar visible, right sidebar collapses
- Right sidebar accessible via toggle button

### 10. WebSocket Protocol Updates

The webchat adapter (`src/channels/adapters/webchat.ts`) needs to handle additional message types:

**Server → Client (new types):**
```typescript
{ type: 'status_update', budget: {...}, agents: [...], jobs: [...], tools: [...], heartbeat: {...} }
{ type: 'job_progress', jobId: string, nodeTitle: string, status: string, summary?: string }
{ type: 'job_started', jobId: string, goal: string, steps: string[] }
{ type: 'job_completed', jobId: string, summary: string }
{ type: 'job_failed', jobId: string, reason: string }
{ type: 'file_received', artifactId: string, filename: string, size: number }
```

**Client → Server (new types):**
```typescript
{ type: 'request_status' }
{ type: 'upload_complete', artifactId: string, filename: string }
```

---

## IMPLEMENTATION APPROACH

**This is a single HTML file.** No build step, no npm, no React, no framework. Just HTML + CSS + vanilla JavaScript. Load markdown rendering and syntax highlighting from CDN. The file should be self-contained and work when served by Fastify's static file handler.

**File location:** `src/channels/webchat/static/index.html` (replace the existing 159-line file)

**Expected size:** 800-1200 lines (HTML + CSS + JS in one file)

**CDN dependencies:**
- `marked` — markdown parsing
- `highlight.js` — code syntax highlighting
- No other external dependencies

**Backend changes needed:**
1. Update `src/channels/adapters/webchat.ts` to handle `request_status` messages
2. Update `src/http/server.ts` to serve the static file and handle `/upload` multipart endpoint
3. The `/status` HTTP endpoint already exists — the sidebar can also fetch it directly

---

## PRIORITY

1. Three-column layout with collapsible sidebars
2. Markdown rendering for bot responses
3. Dark theme
4. Budget widget in right sidebar
5. Sub-agent list in left sidebar
6. Job progress cards (inline + sidebar)
7. Approval cards with action buttons
8. Command autocomplete
9. File upload (drag-and-drop + button)
10. Responsive mobile layout
11. Real-time sidebar updates via WebSocket

---

## WHAT NOT TO DO

- Don't use React, Vue, Svelte, or any framework. Vanilla JS only.
- Don't require a build step. The HTML file must work as-is when served statically.
- Don't add a separate CSS file. Keep everything in one `index.html`.
- Don't over-animate. Subtle transitions only (sidebar open/close, message fade-in).
- Don't make the sidebars cluttered. Each widget should be compact with expandable details.
- Don't use web fonts. System fonts only (`system-ui, -apple-system, sans-serif`).
export interface SlotDef {
  name: string;
  description: string;
  required: boolean;
  default?: unknown;
}

export interface TemplateNodeDef {
  id: string;
  type: string;
  title: string;
  description: string;
  assignedAgent: string;
  model: 'fast' | 'balanced' | 'strong';
  dependencies: string[];
  requiresApproval: boolean;
  input: Record<string, unknown>;
  toolPermissions: string[];
}

export interface GraphTemplate {
  id: string;
  name: string;
  description: string;
  slashCommand?: string;
  alternateMatches: string[];
  slots: SlotDef[];
  nodes: TemplateNodeDef[];
}

export const BUILTIN_TEMPLATES: GraphTemplate[] = [
  {
    id: 'inbox_assistant',
    name: 'Inbox Assistant',
    description: 'List unread emails',
    slashCommand: '/inbox',
    alternateMatches: ['check my email', 'unread emails', 'inbox'],
    slots: [{ name: 'maxResults', description: 'Maximum number of emails', required: false, default: 20 }],
    nodes: [
      { id: 'gmail_list', type: 'gmail.list', title: 'List unread emails', description: 'Fetch unread emails', assignedAgent: 'WorkspaceAgent', model: 'fast', dependencies: [], requiresApproval: false, input: { maxResults: '{{slots.maxResults}}' }, toolPermissions: ['workspace.gmail.read'] },
      { id: 'gmail_summarize', type: 'gmail.summarize', title: 'Summarize email threads', description: 'Generate summary', assignedAgent: 'WorkspaceAgent', model: 'balanced', dependencies: ['gmail_list'], requiresApproval: false, input: {}, toolPermissions: ['workspace.gmail.read'] },
      { id: 'aggregate', type: 'aggregate', title: 'Format response', description: 'Format email summary', assignedAgent: 'AggregatorAgent', model: 'fast', dependencies: ['gmail_summarize'], requiresApproval: false, input: {}, toolPermissions: [] },
    ],
  },
  {
    id: 'draft_reply',
    name: 'Draft Reply',
    description: 'Reply to email thread',
    slashCommand: '/draft',
    alternateMatches: ['reply to', 'draft a response', 'write back to'],
    slots: [
      { name: 'threadId', description: 'Email thread ID', required: false, default: null },
      { name: 'instructions', description: 'Custom instructions for draft', required: false, default: null },
    ],
    nodes: [
      { id: 'gmail_fetch', type: 'gmail.fetch', title: 'Fetch email thread', description: 'Retrieve full thread', assignedAgent: 'WorkspaceAgent', model: 'fast', dependencies: [], requiresApproval: false, input: { threadId: '{{slots.threadId}}' }, toolPermissions: ['workspace.gmail.read'] },
      { id: 'gmail_draft', type: 'gmail.draft', title: 'Draft reply', description: 'Generate draft reply', assignedAgent: 'WorkspaceAgent', model: 'balanced', dependencies: ['gmail_fetch'], requiresApproval: false, input: { instructions: '{{slots.instructions}}' }, toolPermissions: ['workspace.gmail.draft'] },
      { id: 'aggregate', type: 'aggregate', title: 'Show draft preview', description: 'Format draft for review', assignedAgent: 'AggregatorAgent', model: 'fast', dependencies: ['gmail_draft'], requiresApproval: false, input: {}, toolPermissions: [] },
    ],
  },
  {
    id: 'send_email',
    name: 'Send Email',
    description: 'Compose and send an email',
    slashCommand: '/send',
    alternateMatches: ['send an email', 'email to', 'send a message to', 'write an email'],
    slots: [
      { name: 'to', description: 'Recipient email address', required: true, default: null },
      { name: 'subject', description: 'Email subject line', required: false, default: 'Hello' },
      { name: 'instructions', description: 'What the email should say or instructions for drafting', required: false, default: null },
    ],
    nodes: [
      { id: 'gmail_send', type: 'gmail.send', title: 'Send email', description: 'Compose and send the email', assignedAgent: 'WorkspaceAgent', model: 'fast', dependencies: [], requiresApproval: true, input: { to: '{{slots.to}}', subject: '{{slots.subject}}', instructions: '{{slots.instructions}}' }, toolPermissions: ['workspace.gmail.send'] },
    ],
  },
  {
    id: 'todays_calendar',
    name: "Today's Calendar",
    description: "Show today's calendar events",
    slashCommand: '/today',
    alternateMatches: ["what's on my calendar", 'schedule today'],
    slots: [{ name: 'date', description: 'Date to check', required: false, default: 'today' }],
    nodes: [
      { id: 'calendar_list', type: 'calendar.list', title: 'Fetch calendar events', description: 'Retrieve events', assignedAgent: 'WorkspaceAgent', model: 'fast', dependencies: [], requiresApproval: false, input: { date: '{{slots.date}}' }, toolPermissions: ['workspace.calendar.read'] },
      { id: 'aggregate', type: 'aggregate', title: 'Format calendar', description: 'Format events for user', assignedAgent: 'AggregatorAgent', model: 'fast', dependencies: ['calendar_list'], requiresApproval: false, input: {}, toolPermissions: [] },
    ],
  },
  {
    id: 'schedule_event',
    name: 'Schedule Event',
    description: 'Create calendar event',
    slashCommand: '/schedule',
    alternateMatches: ['create a meeting', 'schedule a call', 'book time'],
    slots: [
      { name: 'title', description: 'Event title', required: true, default: null },
      { name: 'date', description: 'Event date', required: true, default: null },
      { name: 'time', description: 'Event start time', required: true, default: null },
      { name: 'duration', description: 'Duration in minutes', required: false, default: 60 },
      { name: 'attendees', description: 'Attendee emails', required: false, default: [] },
    ],
    nodes: [
      { id: 'calendar_create', type: 'calendar.create', title: 'Create event', description: 'Schedule the event', assignedAgent: 'WorkspaceAgent', model: 'balanced', dependencies: [], requiresApproval: true, input: { title: '{{slots.title}}', date: '{{slots.date}}', time: '{{slots.time}}', duration: '{{slots.duration}}', attendees: '{{slots.attendees}}' }, toolPermissions: ['workspace.calendar.write'] },
    ],
  },
  {
    id: 'deep_research',
    name: 'Deep Research',
    description: 'Run in-depth research on a topic',
    slashCommand: '/research',
    alternateMatches: ['research', 'look into', 'find out about'],
    slots: [{ name: 'query', description: 'Research query or topic', required: true, default: null }],
    nodes: [
      { id: 'research_deep', type: 'research.deep', title: 'Run deep research', description: 'Execute deep research', assignedAgent: 'ResearchAgent', model: 'balanced', dependencies: [], requiresApproval: false, input: { query: '{{slots.query}}' }, toolPermissions: ['research.deep'] },
      { id: 'research_summarize', type: 'research.summarize', title: 'Extract key insights', description: 'Summarize findings', assignedAgent: 'ResearchAgent', model: 'balanced', dependencies: ['research_deep'], requiresApproval: false, input: {}, toolPermissions: [] },
      { id: 'aggregate', type: 'aggregate', title: 'Format research report', description: 'Format for user', assignedAgent: 'AggregatorAgent', model: 'fast', dependencies: ['research_summarize'], requiresApproval: false, input: {}, toolPermissions: [] },
    ],
  },
  {
    id: 'research_to_posts',
    name: 'Research to Posts',
    description: 'Research topic and write social media posts',
    alternateMatches: ['research and write tweets', 'write posts about', 'content about'],
    slots: [
      { name: 'query', description: 'Research topic', required: true, default: null },
      { name: 'count', description: 'Number of posts', required: false, default: 4 },
      { name: 'platform', description: 'Target platform', required: false, default: 'twitter' },
    ],
    nodes: [
      { id: 'research_deep', type: 'research.deep', title: 'Run deep research', description: 'Research the topic', assignedAgent: 'ResearchAgent', model: 'balanced', dependencies: [], requiresApproval: false, input: { query: '{{slots.query}}' }, toolPermissions: ['research.deep'] },
      { id: 'research_summarize', type: 'research.summarize', title: 'Extract key insights', description: 'Summarize research', assignedAgent: 'ResearchAgent', model: 'balanced', dependencies: ['research_deep'], requiresApproval: false, input: {}, toolPermissions: [] },
      { id: 'publish_draft_posts', type: 'publish.draft_posts', title: 'Draft posts', description: 'Generate social media posts', assignedAgent: 'PublisherAgent', model: 'balanced', dependencies: ['research_summarize'], requiresApproval: false, input: { count: '{{slots.count}}', platform: '{{slots.platform}}' }, toolPermissions: [] },
      { id: 'publish_post', type: 'publish.post', title: 'Post to platform', description: 'Publish posts', assignedAgent: 'PublisherAgent', model: 'fast', dependencies: ['publish_draft_posts'], requiresApproval: true, input: {}, toolPermissions: [] },
    ],
  },
  {
    id: 'email_calendar_combo',
    name: 'Email & Calendar Combo',
    description: 'Check email and schedule follow-ups',
    alternateMatches: ['check email and schedule follow-ups', 'inbox and meetings'],
    slots: [{ name: 'maxResults', description: 'Maximum emails', required: false, default: 20 }],
    nodes: [
      { id: 'gmail_list', type: 'gmail.list', title: 'List unread emails', description: 'Fetch unread emails', assignedAgent: 'WorkspaceAgent', model: 'fast', dependencies: [], requiresApproval: false, input: { maxResults: '{{slots.maxResults}}' }, toolPermissions: ['workspace.gmail.read'] },
      { id: 'calendar_list', type: 'calendar.list', title: "List today's events", description: "Fetch today's events", assignedAgent: 'WorkspaceAgent', model: 'fast', dependencies: [], requiresApproval: false, input: { date: 'today' }, toolPermissions: ['workspace.calendar.read'] },
      { id: 'gmail_summarize', type: 'gmail.summarize', title: 'Summarize emails', description: 'Generate email summary', assignedAgent: 'WorkspaceAgent', model: 'balanced', dependencies: ['gmail_list'], requiresApproval: false, input: {}, toolPermissions: ['workspace.gmail.read'] },
      { id: 'gmail_draft_replies', type: 'gmail.draft_replies', title: 'Draft replies', description: 'Generate draft replies', assignedAgent: 'WorkspaceAgent', model: 'balanced', dependencies: ['gmail_summarize'], requiresApproval: false, input: {}, toolPermissions: ['workspace.gmail.draft'] },
      { id: 'calendar_propose', type: 'calendar.propose', title: 'Propose follow-ups', description: 'Suggest follow-up meetings', assignedAgent: 'WorkspaceAgent', model: 'balanced', dependencies: ['gmail_summarize', 'calendar_list'], requiresApproval: false, input: {}, toolPermissions: ['workspace.calendar.read'] },
      { id: 'aggregate', type: 'aggregate', title: 'Combined summary', description: 'Format all results', assignedAgent: 'AggregatorAgent', model: 'fast', dependencies: ['gmail_draft_replies', 'calendar_propose'], requiresApproval: false, input: {}, toolPermissions: [] },
    ],
  },
];

const templateMap = new Map<string, GraphTemplate>();

export function initTemplates(): void {
  for (const t of BUILTIN_TEMPLATES) {
    templateMap.set(t.id, t);
  }
}

export function getTemplate(id: string): GraphTemplate | undefined {
  return templateMap.get(id);
}

export function getAllTemplates(): GraphTemplate[] {
  return Array.from(templateMap.values());
}

export function registerTemplate(template: GraphTemplate): void {
  templateMap.set(template.id, template);
}

export function getTemplateBySlashCommand(command: string): GraphTemplate | undefined {
  return Array.from(templateMap.values()).find(
    t => t.slashCommand && command.startsWith(t.slashCommand),
  );
}

// Initialize on module load
initTemplates();

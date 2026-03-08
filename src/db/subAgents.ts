import { v4 as uuid } from 'uuid';
import { getDb } from './connection.js';

export interface SubAgentRow {
  id: string;
  name: string;
  description: string | null;
  persona: string;
  tools: string;
  templates: string;
  default_tier: string;
  budget_daily: number;
  cron_jobs: string | null;
  heartbeat_conds: string | null;
  status: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface CreateSubAgentParams {
  name: string;
  description?: string;
  persona: string;
  tools: string[];
  templates: string[];
  defaultTier?: string;
  budgetDaily?: number;
  cronJobs?: unknown[];
  heartbeatConditions?: string[];
  createdBy?: string;
}

export function createSubAgent(params: CreateSubAgentParams): SubAgentRow {
  const db = getDb();
  const id = uuid();
  const now = Date.now();

  db.prepare(`
    INSERT INTO sub_agents (id, name, description, persona, tools, templates, default_tier,
                            budget_daily, cron_jobs, heartbeat_conds, status, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(
    id,
    params.name,
    params.description ?? null,
    params.persona,
    JSON.stringify(params.tools),
    JSON.stringify(params.templates),
    params.defaultTier ?? 'fast',
    params.budgetDaily ?? 50000,
    params.cronJobs ? JSON.stringify(params.cronJobs) : null,
    params.heartbeatConditions ? JSON.stringify(params.heartbeatConditions) : null,
    params.createdBy ?? 'operator',
    now,
    now,
  );

  return getSubAgent(id)!;
}

export function getSubAgent(id: string): SubAgentRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM sub_agents WHERE id = ?').get(id) as SubAgentRow | undefined;
}

export function getSubAgentByName(name: string): SubAgentRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM sub_agents WHERE name = ?').get(name) as SubAgentRow | undefined;
}

export function getActiveSubAgents(): SubAgentRow[] {
  const db = getDb();
  return db.prepare("SELECT * FROM sub_agents WHERE status = 'active' ORDER BY name")
    .all() as SubAgentRow[];
}

export function getAllSubAgents(): SubAgentRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM sub_agents ORDER BY name')
    .all() as SubAgentRow[];
}

export function updateSubAgentStatus(id: string, status: string): void {
  const db = getDb();
  db.prepare('UPDATE sub_agents SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, Date.now(), id);
}

export function deleteSubAgent(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM sub_agents WHERE id = ?').run(id);
}

/**
 * Seed default sub-agents on first start (idempotent — skips if any exist).
 */
export function seedDefaultSubAgents(): void {
  const existing = getAllSubAgents();
  if (existing.length > 0) return;

  const defaults: CreateSubAgentParams[] = [
    {
      name: 'inbox',
      description: 'Gmail management — list, summarize, draft replies, send emails',
      persona: 'You manage email efficiently. Summarize clearly, draft replies in the user\'s tone.',
      tools: ['workspace'],
      templates: ['inbox_assistant', 'draft_reply', 'send_email'],
      defaultTier: 'fast',
      createdBy: 'system',
    },
    {
      name: 'calendar',
      description: 'Calendar management — view events, schedule meetings, check conflicts',
      persona: 'You manage the user\'s calendar. Be precise with times and attendees.',
      tools: ['workspace'],
      templates: ['todays_calendar', 'schedule_event'],
      defaultTier: 'fast',
      createdBy: 'system',
    },
    {
      name: 'research',
      description: 'Web research via Perplexity — search, deep research, summarize findings',
      persona: 'You conduct thorough research. Cite sources, present findings clearly.',
      tools: ['research'],
      templates: ['deep_research'],
      defaultTier: 'balanced',
      createdBy: 'system',
    },
    {
      name: 'publisher',
      description: 'Content creation — research topics and draft social media posts',
      persona: 'You create engaging content. Match the user\'s brand voice and platform conventions.',
      tools: ['research'],
      templates: ['research_to_posts'],
      defaultTier: 'balanced',
      createdBy: 'system',
    },
  ];

  for (const params of defaults) {
    createSubAgent(params);
  }
}

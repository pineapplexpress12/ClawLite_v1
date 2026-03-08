import { v4 as uuid } from 'uuid';
import { getDb } from './connection.js';

export interface JobRow {
  id: string;
  goal: string;
  status: string;
  trigger_type: string;
  channel: string | null;
  chat_id: string | null;
  job_type: string;
  agent_profile: string;
  sub_agent_id: string | null;
  dry_run: number;
  budget_tokens: number;
  budget_time_ms: number;
  max_parallel_workers: number;
  total_llm_calls: number;
  total_retries: number;
  created_at: number;
  updated_at: number;
}

export interface CreateJobParams {
  goal: string;
  triggerType: string;
  channel?: string;
  chatId?: string;
  jobType?: string;
  agentProfile?: string;
  subAgentId?: string;
  dryRun?: boolean;
  budgetTokens?: number;
  budgetTimeMs?: number;
  maxParallelWorkers?: number;
}

export function createJob(params: CreateJobParams): JobRow {
  const db = getDb();
  const now = Date.now();
  const id = uuid();

  const stmt = db.prepare(`
    INSERT INTO jobs (id, goal, status, trigger_type, channel, chat_id, job_type, agent_profile,
                      sub_agent_id, dry_run, budget_tokens, budget_time_ms, max_parallel_workers,
                      total_llm_calls, total_retries, created_at, updated_at)
    VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
  `);

  stmt.run(
    id,
    params.goal,
    params.triggerType,
    params.channel ?? null,
    params.chatId ?? null,
    params.jobType ?? 'template',
    params.agentProfile ?? 'default',
    params.subAgentId ?? null,
    params.dryRun ? 1 : 0,
    params.budgetTokens ?? 50000,
    params.budgetTimeMs ?? 300000,
    params.maxParallelWorkers ?? 4,
    now,
    now,
  );

  return getJob(id)!;
}

export function getJob(id: string): JobRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
}

export function updateJobStatus(id: string, status: string): void {
  const db = getDb();
  db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, Date.now(), id);
}

export function incrementJobLLMCalls(id: string): void {
  const db = getDb();
  db.prepare('UPDATE jobs SET total_llm_calls = total_llm_calls + 1, updated_at = ? WHERE id = ?')
    .run(Date.now(), id);
}

export function incrementJobRetries(id: string): void {
  const db = getDb();
  db.prepare('UPDATE jobs SET total_retries = total_retries + 1, updated_at = ? WHERE id = ?')
    .run(Date.now(), id);
}

export function getJobsByStatus(statuses: string[]): JobRow[] {
  const db = getDb();
  const placeholders = statuses.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM jobs WHERE status IN (${placeholders}) ORDER BY created_at DESC`)
    .all(...statuses) as JobRow[];
}

export function getRecentJobs(limit: number): JobRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as JobRow[];
}

export function getJobByNodeId(nodeId: string): JobRow | undefined {
  const db = getDb();
  return db.prepare(`
    SELECT j.* FROM jobs j
    JOIN nodes n ON n.job_id = j.id
    WHERE n.id = ?
  `).get(nodeId) as JobRow | undefined;
}

export function deductJobBudget(id: string, tokens: number): void {
  const db = getDb();
  db.prepare('UPDATE jobs SET budget_tokens = budget_tokens - ?, updated_at = ? WHERE id = ?')
    .run(tokens, Date.now(), id);
}

import { v4 as uuid } from 'uuid';
import { getDb } from './connection.js';

export interface NodeRow {
  id: string;
  job_id: string;
  type: string;
  title: string;
  description: string;
  status: string;
  assigned_agent: string;
  model: string;
  dependencies: string;
  input_data: string;
  output_data: string | null;
  artifact_ids: string;
  tool_permissions: string;
  requires_approval: number;
  retry_count: number;
  max_retries: number;
  timeout_ms: number;
  token_budget: number;
  created_at: number;
  updated_at: number;
}

export interface CreateNodeParams {
  jobId: string;
  id?: string;
  type: string;
  title?: string;
  description?: string;
  assignedAgent: string;
  model: string;
  dependencies?: string[];
  inputData?: Record<string, unknown>;
  toolPermissions?: string[];
  requiresApproval?: boolean;
  maxRetries?: number;
  timeoutMs?: number;
  tokenBudget?: number;
}

export function createNode(params: CreateNodeParams): NodeRow {
  const db = getDb();
  const now = Date.now();
  const id = params.id ?? uuid();

  db.prepare(`
    INSERT INTO nodes (id, job_id, type, title, description, status, assigned_agent, model,
                       dependencies, input_data, output_data, artifact_ids, tool_permissions,
                       requires_approval, max_retries, timeout_ms, token_budget, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, NULL, '[]', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.jobId,
    params.type,
    params.title ?? '',
    params.description ?? '',
    params.assignedAgent,
    params.model,
    JSON.stringify(params.dependencies ?? []),
    JSON.stringify(params.inputData ?? {}),
    JSON.stringify(params.toolPermissions ?? []),
    params.requiresApproval ? 1 : 0,
    params.maxRetries ?? 2,
    params.timeoutMs ?? 60000,
    params.tokenBudget ?? 10000,
    now,
    now,
  );

  return getNode(id)!;
}

export function createNodes(nodes: CreateNodeParams[]): NodeRow[] {
  const db = getDb();
  const insertMany = db.transaction((items: CreateNodeParams[]) => {
    return items.map(n => createNode(n));
  });
  return insertMany(nodes);
}

export function getNode(id: string): NodeRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
}

export function getNodesByJobId(jobId: string): NodeRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM nodes WHERE job_id = ? ORDER BY created_at')
    .all(jobId) as NodeRow[];
}

export function getNodesByStatus(jobId: string, status: string): NodeRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM nodes WHERE job_id = ? AND status = ?')
    .all(jobId, status) as NodeRow[];
}

export function countNodes(jobId: string): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE job_id = ?').get(jobId) as { cnt: number };
  return row.cnt;
}

export function countRunningNodes(jobId: string): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as cnt FROM nodes WHERE job_id = ? AND status = 'running'")
    .get(jobId) as { cnt: number };
  return row.cnt;
}

/**
 * Atomic node status transition — wraps status + output in a transaction.
 */
export function transitionNodeStatus(
  nodeId: string,
  newStatus: string,
  output?: Record<string, unknown>,
): void {
  const db = getDb();
  const now = Date.now();
  db.transaction(() => {
    db.prepare('UPDATE nodes SET status = ?, updated_at = ? WHERE id = ?')
      .run(newStatus, now, nodeId);
    if (output !== undefined) {
      db.prepare('UPDATE nodes SET output_data = ? WHERE id = ?')
        .run(JSON.stringify(output), nodeId);
    }
  })();
}

export function updateNodeStatus(nodeId: string, status: string): void {
  const db = getDb();
  db.prepare('UPDATE nodes SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, Date.now(), nodeId);
}

export function updateNodeOutput(nodeId: string, output: Record<string, unknown>): void {
  const db = getDb();
  db.prepare('UPDATE nodes SET output_data = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(output), Date.now(), nodeId);
}

export function incrementRetryCount(nodeId: string): void {
  const db = getDb();
  db.prepare('UPDATE nodes SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?')
    .run(Date.now(), nodeId);
}

export function addArtifactId(nodeId: string, artifactId: string): void {
  const db = getDb();
  const node = getNode(nodeId);
  if (!node) return;
  const ids: string[] = JSON.parse(node.artifact_ids);
  ids.push(artifactId);
  db.prepare('UPDATE nodes SET artifact_ids = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(ids), Date.now(), nodeId);
}

export function resetRunningNodesToPending(): number {
  const db = getDb();
  const result = db.prepare("UPDATE nodes SET status = 'pending', updated_at = ? WHERE status = 'running'")
    .run(Date.now());
  return result.changes;
}

export function markRunningNodesAsInterrupted(jobId: string): void {
  const db = getDb();
  db.prepare("UPDATE nodes SET status = 'pending', updated_at = ? WHERE job_id = ? AND status = 'running'")
    .run(Date.now(), jobId);
}

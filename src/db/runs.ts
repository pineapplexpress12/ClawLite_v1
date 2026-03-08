import { v4 as uuid } from 'uuid';
import { getDb } from './connection.js';

export interface RunRow {
  id: string;
  node_id: string;
  start_time: number;
  end_time: number | null;
  cost_tokens: number;
  status: string;
}

export function insertRun(nodeId: string): RunRow {
  const db = getDb();
  const id = uuid();
  const now = Date.now();

  db.prepare(`
    INSERT INTO runs (id, node_id, start_time, status)
    VALUES (?, ?, ?, 'running')
  `).run(id, nodeId, now);

  return { id, node_id: nodeId, start_time: now, end_time: null, cost_tokens: 0, status: 'running' };
}

export function completeRun(nodeId: string, status: string, costTokens: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE runs SET end_time = ?, cost_tokens = ?, status = ?
    WHERE node_id = ? AND status = 'running'
  `).run(Date.now(), costTokens, status, nodeId);
}

export function getRunsByNodeId(nodeId: string): RunRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM runs WHERE node_id = ? ORDER BY start_time DESC')
    .all(nodeId) as RunRow[];
}

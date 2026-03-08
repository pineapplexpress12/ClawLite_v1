import { v4 as uuid } from 'uuid';
import { getDb } from './connection.js';

export interface LedgerRow {
  id: string;
  agent: string;
  tool: string | null;
  action: string;
  params: string | null;
  result: string | null;
  status: string;
  timestamp: number;
  cost: number;
  metadata: string | null;
}

export interface InsertLedgerParams {
  agent: string;
  tool?: string;
  action: string;
  params?: unknown;
  result?: unknown;
  status: string;
  cost?: number;
  metadata?: Record<string, unknown>;
}

export function insertLedgerEntry(params: InsertLedgerParams): string {
  const db = getDb();
  const id = uuid();
  const now = Date.now();

  db.prepare(`
    INSERT INTO ledger (id, agent, tool, action, params, result, status, timestamp, cost, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.agent,
    params.tool ?? null,
    params.action,
    params.params ? JSON.stringify(params.params) : null,
    params.result ? JSON.stringify(params.result) : null,
    params.status,
    now,
    params.cost ?? 0,
    params.metadata ? JSON.stringify(params.metadata) : null,
  );

  return id;
}

export function updateLedgerEntry(id: string, updates: { status?: string; result?: unknown; cost?: number }): void {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) {
    sets.push('status = ?');
    values.push(updates.status);
  }
  if (updates.result !== undefined) {
    sets.push('result = ?');
    values.push(JSON.stringify(updates.result));
  }
  if (updates.cost !== undefined) {
    sets.push('cost = ?');
    values.push(updates.cost);
  }

  if (sets.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE ledger SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function getRecentLedgerEntries(limit: number): LedgerRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM ledger ORDER BY timestamp DESC LIMIT ?')
    .all(limit) as LedgerRow[];
}

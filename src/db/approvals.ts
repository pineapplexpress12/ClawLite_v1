import { v4 as uuid } from 'uuid';
import { getDb } from './connection.js';

export interface ApprovalRow {
  id: string;
  node_id: string;
  action_type: string;
  title: string;
  preview: string;
  payload: string;
  status: string;
  created_at: number;
}

export interface CreateApprovalParams {
  nodeId: string;
  actionType: string;
  title: string;
  preview: string;
  payload: Record<string, unknown>;
}

export function createApproval(params: CreateApprovalParams): string {
  const db = getDb();
  const id = uuid();
  const now = Date.now();

  db.prepare(`
    INSERT INTO approvals (id, node_id, action_type, title, preview, payload, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, params.nodeId, params.actionType, params.title, params.preview, JSON.stringify(params.payload), now);

  return id;
}

export function getApproval(id: string): ApprovalRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
}

export function getPendingApprovalByNodeId(nodeId: string): ApprovalRow | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM approvals WHERE node_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1")
    .get(nodeId) as ApprovalRow | undefined;
}

export function updateApprovalStatus(id: string, status: string): void {
  const db = getDb();
  db.prepare('UPDATE approvals SET status = ? WHERE id = ?').run(status, id);
}

export function getPendingApprovals(): ApprovalRow[] {
  const db = getDb();
  return db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC")
    .all() as ApprovalRow[];
}

// Pending revisions
export interface PendingRevisionRow {
  id: string;
  chat_id: string;
  channel: string;
  approval_id: string;
  created_at: number;
}

export function setPendingRevision(chatId: string, channel: string, approvalId: string): void {
  const db = getDb();
  const id = uuid();
  // Remove any existing revision for this chat
  db.prepare('DELETE FROM pending_revisions WHERE chat_id = ? AND channel = ?').run(chatId, channel);
  db.prepare(`
    INSERT INTO pending_revisions (id, chat_id, channel, approval_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, chatId, channel, approvalId, Date.now());
}

export function getPendingRevision(chatId: string, channel: string): PendingRevisionRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM pending_revisions WHERE chat_id = ? AND channel = ?')
    .get(chatId, channel) as PendingRevisionRow | undefined;
}

export function clearPendingRevision(chatId: string, channel: string): void {
  const db = getDb();
  db.prepare('DELETE FROM pending_revisions WHERE chat_id = ? AND channel = ?').run(chatId, channel);
}

// Pending approval choices (WhatsApp)
export function setPendingApprovalChoice(chatId: string, channel: string, approvalId: string): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO pending_approval_choices (chat_id, channel, approval_id, created_at)
    VALUES (?, ?, ?, ?)
  `).run(chatId, channel, approvalId, Date.now());
}

export function getPendingApprovalChoice(chatId: string, channel: string): string | undefined {
  const db = getDb();
  const row = db.prepare('SELECT approval_id FROM pending_approval_choices WHERE chat_id = ? AND channel = ?')
    .get(chatId, channel) as { approval_id: string } | undefined;
  return row?.approval_id;
}

export function clearPendingApprovalChoice(chatId: string, channel: string): void {
  const db = getDb();
  db.prepare('DELETE FROM pending_approval_choices WHERE chat_id = ? AND channel = ?').run(chatId, channel);
}

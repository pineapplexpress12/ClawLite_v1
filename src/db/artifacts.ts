import { v4 as uuid } from 'uuid';
import { getDb } from './connection.js';

export interface ArtifactRow {
  id: string;
  job_id: string | null;
  node_id: string | null;
  type: string;
  title: string;
  content: string | null;
  path: string | null;
  mime_type: string | null;
  file_size: number | null;
  metadata: string | null;
  created_at: number;
}

export interface StoreTextArtifactParams {
  jobId?: string;
  nodeId?: string;
  type: string;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface StoreFileArtifactParams {
  jobId?: string;
  nodeId?: string;
  type: string;
  title: string;
  path: string;
  mimeType?: string;
  fileSize?: number;
  metadata?: Record<string, unknown>;
}

export function storeTextArtifact(params: StoreTextArtifactParams): string {
  const db = getDb();
  const id = uuid();
  const now = Date.now();

  db.prepare(`
    INSERT INTO artifacts (id, job_id, node_id, type, title, content, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.jobId ?? null,
    params.nodeId ?? null,
    params.type,
    params.title,
    params.content,
    params.metadata ? JSON.stringify(params.metadata) : null,
    now,
  );

  return id;
}

export function storeFileArtifact(params: StoreFileArtifactParams): string {
  const db = getDb();
  const id = uuid();
  const now = Date.now();

  db.prepare(`
    INSERT INTO artifacts (id, job_id, node_id, type, title, path, mime_type, file_size, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.jobId ?? null,
    params.nodeId ?? null,
    params.type,
    params.title,
    params.path,
    params.mimeType ?? null,
    params.fileSize ?? null,
    params.metadata ? JSON.stringify(params.metadata) : null,
    now,
  );

  return id;
}

export function getArtifact(id: string): ArtifactRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRow | undefined;
}

export function getArtifactsByJobId(jobId: string): ArtifactRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM artifacts WHERE job_id = ? ORDER BY created_at')
    .all(jobId) as ArtifactRow[];
}

export function getArtifactsByNodeId(nodeId: string): ArtifactRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM artifacts WHERE node_id = ? ORDER BY created_at')
    .all(nodeId) as ArtifactRow[];
}

export function getArtifactsByNodeIds(nodeIds: string[]): ArtifactRow[] {
  if (nodeIds.length === 0) return [];
  const db = getDb();
  const placeholders = nodeIds.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM artifacts WHERE node_id IN (${placeholders}) ORDER BY created_at`)
    .all(...nodeIds) as ArtifactRow[];
}

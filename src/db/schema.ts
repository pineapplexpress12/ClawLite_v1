import type Database from 'better-sqlite3';

const SCHEMA_SQL = `
-- Jobs table
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  goal          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','planning','ready','running','waiting_approval','completed','failed','cancelled')),
  trigger_type  TEXT NOT NULL DEFAULT 'channel_message'
                CHECK (trigger_type IN ('channel_message','cron','webhook','heartbeat','system')),
  channel       TEXT,
  chat_id       TEXT,
  job_type      TEXT NOT NULL DEFAULT 'template'
                CHECK (job_type IN ('template','agentic')),
  agent_profile TEXT NOT NULL DEFAULT 'default',
  sub_agent_id  TEXT,
  dry_run       INTEGER NOT NULL DEFAULT 0,
  budget_tokens INTEGER NOT NULL DEFAULT 50000,
  budget_time_ms INTEGER NOT NULL DEFAULT 300000,
  max_parallel_workers INTEGER NOT NULL DEFAULT 4,
  total_llm_calls INTEGER NOT NULL DEFAULT 0,
  total_retries   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Nodes table
CREATE TABLE IF NOT EXISTS nodes (
  id                TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL,
  type              TEXT NOT NULL,
  title             TEXT NOT NULL DEFAULT '',
  description       TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','queued','running','waiting_approval','completed','failed','cancelled')),
  assigned_agent    TEXT NOT NULL,
  model             TEXT NOT NULL CHECK (model IN ('fast','balanced','strong')),
  dependencies      TEXT NOT NULL DEFAULT '[]',
  input_data        TEXT NOT NULL DEFAULT '{}',
  output_data       TEXT,
  artifact_ids      TEXT NOT NULL DEFAULT '[]',
  tool_permissions  TEXT NOT NULL DEFAULT '[]',
  requires_approval INTEGER NOT NULL DEFAULT 0,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  max_retries       INTEGER NOT NULL DEFAULT 2,
  timeout_ms        INTEGER NOT NULL DEFAULT 60000,
  token_budget      INTEGER NOT NULL DEFAULT 10000,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_nodes_job ON nodes(job_id);
CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(job_id, status);

-- Runs table
CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  node_id     TEXT NOT NULL,
  start_time  INTEGER NOT NULL,
  end_time    INTEGER,
  cost_tokens INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'running'
              CHECK (status IN ('running','completed','failed')),
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_runs_node ON runs(node_id);

-- Ledger table
CREATE TABLE IF NOT EXISTS ledger (
  id        TEXT PRIMARY KEY,
  agent     TEXT NOT NULL,
  tool      TEXT,
  action    TEXT NOT NULL,
  params    TEXT,
  result    TEXT,
  status    TEXT NOT NULL DEFAULT 'started'
            CHECK (status IN ('started','success','error','blocked','dry_run')),
  timestamp INTEGER NOT NULL,
  cost      INTEGER NOT NULL DEFAULT 0,
  metadata  TEXT
);
CREATE INDEX IF NOT EXISTS idx_ledger_time ON ledger(timestamp DESC);

-- Memory table
CREATE TABLE IF NOT EXISTS memory (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('episodic','semantic','procedural')),
  content     TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',
  token_count INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type);
CREATE INDEX IF NOT EXISTS idx_memory_expires ON memory(expires_at);

-- Daily budget (single-row table)
CREATE TABLE IF NOT EXISTS daily_budget (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  window_start    INTEGER NOT NULL,
  tokens_consumed INTEGER NOT NULL DEFAULT 0
);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     TEXT NOT NULL,
  channel     TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content     TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_chat ON sessions(chat_id, channel, created_at DESC);

-- Sub-agents table
CREATE TABLE IF NOT EXISTS sub_agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  persona         TEXT NOT NULL,
  tools           TEXT NOT NULL DEFAULT '[]',
  templates       TEXT NOT NULL DEFAULT '[]',
  default_tier    TEXT NOT NULL DEFAULT 'fast'
                  CHECK (default_tier IN ('fast','balanced','strong')),
  budget_daily    INTEGER NOT NULL DEFAULT 50000,
  cron_jobs       TEXT,
  heartbeat_conds TEXT,
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','paused','disabled')),
  created_by      TEXT NOT NULL DEFAULT 'operator',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- Approvals table
CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT PRIMARY KEY,
  node_id     TEXT NOT NULL,
  action_type TEXT NOT NULL,
  title       TEXT NOT NULL,
  preview     TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','approved','rejected','revision_requested')),
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_approvals_node ON approvals(node_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

-- Pending revisions (for approval revision flow)
CREATE TABLE IF NOT EXISTS pending_revisions (
  id          TEXT PRIMARY KEY,
  chat_id     TEXT NOT NULL,
  channel     TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_chat ON pending_revisions(chat_id, channel);

-- Pending approval choices (WhatsApp numbered replies)
CREATE TABLE IF NOT EXISTS pending_approval_choices (
  chat_id     TEXT NOT NULL,
  channel     TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (chat_id, channel)
);

-- Artifacts table
CREATE TABLE IF NOT EXISTS artifacts (
  id          TEXT PRIMARY KEY,
  job_id      TEXT,
  node_id     TEXT,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  content     TEXT,
  path        TEXT,
  mime_type   TEXT,
  file_size   INTEGER,
  metadata    TEXT,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_job ON artifacts(job_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_node ON artifacts(node_id);
`;

const FTS_SQL = `
-- FTS5 virtual table for memory full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  content,
  tags,
  content=memory,
  content_rowid=rowid
);

-- Triggers to keep FTS in sync with memory table
CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, content, tags) VALUES (NEW.rowid, NEW.content, NEW.tags);
END;

CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content, tags) VALUES ('delete', OLD.rowid, OLD.content, OLD.tags);
END;

CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content, tags) VALUES ('delete', OLD.rowid, OLD.content, OLD.tags);
  INSERT INTO memory_fts(rowid, content, tags) VALUES (NEW.rowid, NEW.content, NEW.tags);
END;
`;

const SEED_SQL = `
-- Initialize daily budget if not exists
INSERT OR IGNORE INTO daily_budget (id, window_start, tokens_consumed)
VALUES (1, ${Date.now()}, 0);
`;

export function runMigrations(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
  db.exec(FTS_SQL);
  db.exec(SEED_SQL);
}

-- RAYAN CORTEX — Cloudflare D1 (SQLite) schema
-- Apply: wrangler d1 execute <DB_NAME> --file=./sql/schema.sql
-- All timestamps are Unix epoch milliseconds.

-- ---------------------------------------------------------------- Memory
-- Strict isolation: every query issued by D1MemoryAdapter filters on user_id.
CREATE TABLE IF NOT EXISTS cortex_memory (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('short-term','long-term','user','project','agent')),
  namespace   TEXT NOT NULL DEFAULT '',          -- sessionId | projectId | agentSlug | ''
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,                     -- JSON
  tags        TEXT NOT NULL DEFAULT '[]',        -- JSON array
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  expires_at  INTEGER,                           -- NULL = never
  UNIQUE (user_id, scope, namespace, key)
);
CREATE INDEX IF NOT EXISTS idx_memory_user_scope ON cortex_memory (user_id, scope, namespace, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_expires ON cortex_memory (expires_at) WHERE expires_at IS NOT NULL;

-- ---------------------------------------------------------------- Audit (append-only, hash-chained)
CREATE TABLE IF NOT EXISTS cortex_audit (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  at         INTEGER NOT NULL,
  user_id    TEXT NOT NULL,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  decision   TEXT CHECK (decision IS NULL OR decision IN ('allowed','denied','approval_required','info')),
  details    TEXT,                               -- JSON, secrets redacted
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_user_at ON cortex_audit (user_id, at);
-- Make the log append-only at the database level.
CREATE TRIGGER IF NOT EXISTS trg_audit_no_update BEFORE UPDATE ON cortex_audit
BEGIN SELECT RAISE(ABORT, 'cortex_audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete BEFORE DELETE ON cortex_audit
BEGIN SELECT RAISE(ABORT, 'cortex_audit is append-only'); END;

-- ---------------------------------------------------------------- Tasks (plans + steps)
CREATE TABLE IF NOT EXISTS cortex_tasks (
  id           TEXT PRIMARY KEY,                 -- plan id
  request_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  project_id   TEXT,
  goal         TEXT NOT NULL,
  intent       TEXT NOT NULL CHECK (intent IN ('chat','code','research','content','image','automation','admin','analysis')),
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','running','succeeded','partial','failed','cancelled','awaiting_approval')),
  plan_json    TEXT NOT NULL,
  eval_score   REAL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON cortex_tasks (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cortex_task_steps (
  task_id      TEXT NOT NULL REFERENCES cortex_tasks(id) ON DELETE CASCADE,
  step_id      TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  agent_slug   TEXT,
  capability   TEXT NOT NULL,
  depends_on   TEXT NOT NULL DEFAULT '[]',       -- JSON array of step ids
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','running','succeeded','failed','skipped','cancelled','awaiting_approval')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  output_json  TEXT,
  error        TEXT,
  started_at   INTEGER,
  ended_at     INTEGER,
  PRIMARY KEY (task_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_steps_user_status ON cortex_task_steps (user_id, status);

-- ---------------------------------------------------------------- Approvals
CREATE TABLE IF NOT EXISTS cortex_approvals (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  agent_slug    TEXT NOT NULL,
  action        TEXT NOT NULL,
  level         TEXT NOT NULL CHECK (level IN ('guarded','restricted')),
  fingerprint   TEXT NOT NULL,
  input_preview TEXT,
  status        TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired','consumed')),
  approved_by   TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_user_status ON cortex_approvals (user_id, status);

-- ---------------------------------------------------------------- Quotas (CostController / D1QuotaStore)
CREATE TABLE IF NOT EXISTS cortex_quota_usage (
  key         TEXT PRIMARY KEY,                  -- "<service>:<YYYY-MM-DD>"
  used        REAL NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

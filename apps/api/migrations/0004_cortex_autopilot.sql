-- RAYAN Phase 2 — tables for @rayan/cortex and @rayan/autopilot.
-- Copied from packages/cortex/sql/schema.sql and packages/autopilot/sql/schema.sql with index/trigger
-- names prefixed (cortex_*/autopilot_*) so nothing clashes with the phase-1 schema (tasks, audit_logs, ...).
-- Integration notes:
--   * Queued cortex work uses the existing `tasks` table (type 'cortex.run'); cortex_tasks/cortex_task_steps
--     store the plan + step outcome of every cortex run (linked by task_ref when it came from the queue).
--   * Security-relevant API actions are still written to the existing `audit_logs`; cortex_audit holds the
--     module's own hash-chained, append-only trail of tool decisions.
--   * Cost: Workers AI calls are capped by the existing usage_counters controller; cortex_quota_usage is kept
--     for the module's CostController (non-AI services) and is unused by default.

-- RAYAN CORTEX — Cloudflare D1 (SQLite) schema
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
CREATE INDEX IF NOT EXISTS idx_cortex_memory_user_scope ON cortex_memory (user_id, scope, namespace, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_cortex_memory_expires ON cortex_memory (expires_at) WHERE expires_at IS NOT NULL;

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
CREATE INDEX IF NOT EXISTS idx_cortex_audit_user_at ON cortex_audit (user_id, at);
-- Make the log append-only at the database level.
CREATE TRIGGER IF NOT EXISTS trg_cortex_audit_no_update BEFORE UPDATE ON cortex_audit
BEGIN SELECT RAISE(ABORT, 'cortex_audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_cortex_audit_no_delete BEFORE DELETE ON cortex_audit
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
  task_ref     TEXT,                             -- tasks.id when run from the queue (cortex.run)
  output       TEXT,
  errors_json  TEXT NOT NULL DEFAULT '[]',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cortex_tasks_user ON cortex_tasks (user_id, created_at DESC);

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
CREATE INDEX IF NOT EXISTS idx_cortex_steps_user_status ON cortex_task_steps (user_id, status);

-- ---------------------------------------------------------------- Approvals
CREATE TABLE IF NOT EXISTS cortex_approvals (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  agent_slug    TEXT NOT NULL,
  action        TEXT NOT NULL,
  level         TEXT NOT NULL CHECK (level IN ('guarded','restricted')),
  fingerprint   TEXT NOT NULL,
  input_preview TEXT,
  reason        TEXT,
  request_id    TEXT,                            -- cortex request that produced it
  goal          TEXT,                            -- the user goal to re-run after approval
  status        TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired','consumed')),
  approved_by   TEXT,
  decided_at    INTEGER,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cortex_approvals_user_status ON cortex_approvals (user_id, status);
CREATE INDEX IF NOT EXISTS idx_cortex_approvals_fingerprint ON cortex_approvals (user_id, fingerprint, status);

-- ---------------------------------------------------------------- Quotas (CostController / D1QuotaStore)
CREATE TABLE IF NOT EXISTS cortex_quota_usage (
  key         TEXT PRIMARY KEY,                  -- "<service>:<YYYY-MM-DD>"
  used        REAL NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

-- RAYAN AUTOPILOT — Cloudflare D1 (SQLite) schema
-- All timestamps are epoch milliseconds (INTEGER) unless the column name ends with _date (ISO YYYY-MM-DD).


-- ---------- Scheduler ----------
CREATE TABLE IF NOT EXISTS autopilot_jobs (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  cron                TEXT NOT NULL,
  handler             TEXT NOT NULL,
  payload_json        TEXT NOT NULL DEFAULT 'null',
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed')),
  utc_offset_minutes  INTEGER NOT NULL DEFAULT 0,
  max_runs            INTEGER CHECK (max_runs IS NULL OR max_runs > 0),
  run_count           INTEGER NOT NULL DEFAULT 0,
  failure_count       INTEGER NOT NULL DEFAULT 0,
  next_run_at         INTEGER,
  last_run_at         INTEGER,
  last_error          TEXT,
  lock_owner          TEXT,
  lock_expires_at     INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_autopilot_jobs_due ON autopilot_jobs (status, next_run_at);

CREATE TABLE IF NOT EXISTS autopilot_job_runs (
  id               TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL REFERENCES autopilot_jobs(id) ON DELETE CASCADE,
  idempotency_key  TEXT NOT NULL UNIQUE,
  scheduled_for    INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER,
  error            TEXT,
  result_json      TEXT
);
CREATE INDEX IF NOT EXISTS idx_autopilot_job_runs_job ON autopilot_job_runs (job_id, started_at DESC);

-- ---------- Custom (admin-defined) calendar events ----------
CREATE TABLE IF NOT EXISTS autopilot_events (
  id            TEXT PRIMARY KEY,                -- a-z0-9_- ; must not clash with built-in ids
  business_id   TEXT,                            -- NULL = global
  title         TEXT NOT NULL,
  title_fa      TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'custom',
  rule_json     TEXT NOT NULL,                   -- EventRule, e.g. {"type":"jalali","month":7,"day":1}
  tags_json     TEXT NOT NULL DEFAULT '[]',
  sensitivity   TEXT NOT NULL DEFAULT 'celebration' CHECK (sensitivity IN ('celebration','neutral','mourning')),
  duration_days INTEGER NOT NULL DEFAULT 1,
  lead_days     INTEGER NOT NULL DEFAULT 7,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_autopilot_events_business ON autopilot_events (business_id, enabled);

-- ---------- Campaign drafts ----------
CREATE TABLE IF NOT EXISTS autopilot_campaigns (
  id                 TEXT PRIMARY KEY,
  business_id        TEXT NOT NULL,
  event_instance_id  TEXT NOT NULL,              -- e.g. yalda@2026-12-21
  status             TEXT NOT NULL DEFAULT 'pending_approval'
                       CHECK (status IN ('pending_approval','approved','rejected','published','sent','archived')),
  version            INTEGER NOT NULL DEFAULT 1,
  relevance_score    INTEGER NOT NULL DEFAULT 0,
  generator          TEXT NOT NULL CHECK (generator IN ('llm','template')),
  draft_json         TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_autopilot_campaigns_business ON autopilot_campaigns (business_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_autopilot_campaigns_event ON autopilot_campaigns (business_id, event_instance_id, version);

-- ---------- Approvals (append-only audit log) ----------
CREATE TABLE IF NOT EXISTS autopilot_approvals (
  id            TEXT PRIMARY KEY,
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('campaign','snapshot','theme_proposal','send_batch')),
  subject_id    TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('publish','send','promote','rollback','apply')),
  content_hash  TEXT NOT NULL,                   -- sha256 of the approved content
  decision      TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  approver_id   TEXT NOT NULL,
  approver_json TEXT NOT NULL,
  decided_at    INTEGER NOT NULL,
  expires_at    INTEGER,
  note          TEXT
);
CREATE INDEX IF NOT EXISTS idx_autopilot_approvals_subject ON autopilot_approvals (subject_type, subject_id, action, decided_at);
CREATE TRIGGER IF NOT EXISTS trg_autopilot_approvals_no_update BEFORE UPDATE ON autopilot_approvals
BEGIN SELECT RAISE(ABORT, 'approvals are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_autopilot_approvals_no_delete BEFORE DELETE ON autopilot_approvals
BEGIN SELECT RAISE(ABORT, 'approvals are append-only'); END;

-- ---------- Website snapshots ----------
CREATE TABLE IF NOT EXISTS autopilot_snapshots (
  id            TEXT PRIMARY KEY,
  site_id       TEXT NOT NULL,
  environment   TEXT NOT NULL CHECK (environment IN ('staging','production')),
  label         TEXT NOT NULL DEFAULT '',
  reason        TEXT NOT NULL CHECK (reason IN ('manual','pre_change','promotion','rollback','theme_apply')),
  content_json  TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  parent_id     TEXT REFERENCES autopilot_snapshots(id),
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_autopilot_snapshots_site ON autopilot_snapshots (site_id, environment, created_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_autopilot_snapshots_immutable BEFORE UPDATE ON autopilot_snapshots
BEGIN SELECT RAISE(ABORT, 'snapshots are immutable'); END;

CREATE TABLE IF NOT EXISTS autopilot_site_pointers (
  site_id      TEXT NOT NULL,
  environment  TEXT NOT NULL CHECK (environment IN ('staging','production')),
  snapshot_id  TEXT NOT NULL REFERENCES autopilot_snapshots(id),
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (site_id, environment)
);

-- ---------- Anti-spam ----------
CREATE TABLE IF NOT EXISTS autopilot_send_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  scope    TEXT NOT NULL,                        -- 'global:sms' | 'recipient:<contactId>'
  sent_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_autopilot_send_log_scope ON autopilot_send_log (scope, sent_at);

CREATE TABLE IF NOT EXISTS autopilot_send_dedupe (
  dedupe_key  TEXT PRIMARY KEY,                  -- '<campaignId>:<contactId>:<channel>'
  claimed_at  INTEGER NOT NULL
);

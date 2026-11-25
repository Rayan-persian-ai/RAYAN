-- RAYAN AUTOPILOT — Cloudflare D1 (SQLite) schema
-- Apply: wrangler d1 execute <DB_NAME> --file=sql/schema.sql
-- All timestamps are epoch milliseconds (INTEGER) unless the column name ends with _date (ISO YYYY-MM-DD).

PRAGMA foreign_keys = ON;

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

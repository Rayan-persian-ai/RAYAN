-- RAYAN Phase 1 — core schema. All timestamps are Unix epoch milliseconds (INTEGER).

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

-- id = SHA-256 (hex) of the opaque session token; the raw token only lives in the cookie.
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE roles (
  name           TEXT PRIMARY KEY,
  description_fa TEXT NOT NULL
);

CREATE TABLE permissions (
  name           TEXT PRIMARY KEY,
  description_fa TEXT NOT NULL
);

CREATE TABLE role_permissions (
  role       TEXT NOT NULL REFERENCES roles(name) ON DELETE CASCADE,
  permission TEXT NOT NULL REFERENCES permissions(name) ON DELETE CASCADE,
  PRIMARY KEY (role, permission)
);

CREATE TABLE user_roles (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL REFERENCES roles(name) ON DELETE CASCADE,
  granted_by TEXT,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, role)
);

CREATE TABLE audit_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id TEXT,
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  ip            TEXT,
  user_agent    TEXT,
  metadata      TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
CREATE INDEX idx_audit_actor ON audit_logs(actor_user_id);

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  payload      TEXT NOT NULL DEFAULT '{}',
  result       TEXT,
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  agent_slug   TEXT REFERENCES agents(slug),
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER,
  next_run_at  INTEGER,
  locked_until INTEGER
);
CREATE INDEX idx_tasks_status_next ON tasks(status, next_run_at);
CREATE INDEX idx_tasks_created_by ON tasks(created_by, created_at);

-- Agent registry: one row per manifest in packages/shared/agents.
CREATE TABLE agents (
  slug        TEXT PRIMARY KEY,
  name_fa     TEXT NOT NULL,
  name_en     TEXT NOT NULL,
  description TEXT NOT NULL,
  permissions TEXT NOT NULL CHECK (json_valid(permissions)),
  enabled     INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  version     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Cost controller. day = 'YYYY-MM-DD' (UTC, matches Workers AI reset) or 'default' for the per-service default cap.
CREATE TABLE usage_counters (
  service    TEXT NOT NULL,
  day        TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  "limit"    INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (service, day)
);

CREATE TABLE scheduled_jobs (
  name             TEXT PRIMARY KEY,
  cron             TEXT,
  last_run_at      INTEGER,
  last_status      TEXT CHECK (last_status IN ('ok', 'error')),
  last_error       TEXT,
  last_duration_ms INTEGER,
  run_count        INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE feature_flags (
  key            TEXT PRIMARY KEY,
  enabled        INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  description_fa TEXT NOT NULL,
  updated_by     TEXT,
  updated_at     INTEGER NOT NULL
);

-- Fixed-window rate limiter state (per IP / per user / per email keys).
CREATE TABLE rate_limits (
  key          TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX idx_rate_limits_window ON rate_limits(window_start);

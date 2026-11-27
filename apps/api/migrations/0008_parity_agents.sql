-- RAYAN Phase 4 batch 3 + ChatGPT parity: pinned chats, projects, user memory, attachments (D1, no R2),
-- admin-managed agents with run log, approval queue and one-time codes. Timestamps: epoch ms.

ALTER TABLE conversations ADD COLUMN pinned_at INTEGER;
ALTER TABLE conversations ADD COLUMN project_id TEXT;
ALTER TABLE conversations ADD COLUMN model TEXT;

CREATE TABLE projects (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_projects_user ON projects(user_id, updated_at DESC);
CREATE INDEX idx_conversations_project ON conversations(project_id);

CREATE TABLE user_memories (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_memories_user ON user_memories(user_id, updated_at DESC);

-- Uploaded files. Text files: extracted text only (browser-side). Images: downscaled JPEG/PNG/WebP data URL
-- (<= 400 KB). Per-user caps enforced in code; nothing is stored outside D1.
CREATE TABLE attachments (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('text', 'image')),
  name            TEXT NOT NULL,
  mime            TEXT NOT NULL,
  size            INTEGER NOT NULL,
  data            TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_attachments_user ON attachments(user_id, created_at DESC);
CREATE INDEX idx_attachments_conv ON attachments(conversation_id);

-- Admin-managed agents (separate from the static 20-manifest registry).
CREATE TABLE agent_bots (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,
  tools         TEXT NOT NULL DEFAULT '[]',
  approval_rule TEXT NOT NULL DEFAULT 'external' CHECK (approval_rule IN ('external', 'all')),
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE agent_runs (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agent_bots(id) ON DELETE CASCADE,
  tool        TEXT NOT NULL,
  input       TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'pending_approval', 'needs_gmail')),
  output      TEXT,
  steps       TEXT NOT NULL DEFAULT '[]',
  error       TEXT,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX idx_agent_runs_agent ON agent_runs(agent_id, created_at DESC);
CREATE INDEX idx_agent_runs_created ON agent_runs(created_at DESC);

-- Approval queue for outbound sends. content_hash binds the decision to exactly what was reviewed.
CREATE TABLE agent_actions (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL REFERENCES agent_bots(id) ON DELETE CASCADE,
  tool         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'rejected', 'failed')),
  result       TEXT,
  decided_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at   INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_agent_actions_status ON agent_actions(status, created_at DESC);

-- Verification / notification codes sent by agents (HMAC only, 15-minute expiry).
CREATE TABLE agent_codes (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agent_bots(id) ON DELETE CASCADE,
  email      TEXT NOT NULL COLLATE NOCASE,
  purpose    TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX idx_agent_codes_email ON agent_codes(email, created_at DESC);

-- Generated images (Workers AI FLUX.2 / Leonardo, or Pollinations fetched + validated server-side).
-- Bounded: newest IMAGE_KEEP_PER_USER per user; older rows are pruned (prompt kept in the chat message).
CREATE TABLE gen_images (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  prompt          TEXT NOT NULL,
  en_prompt       TEXT NOT NULL,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  width           INTEGER NOT NULL,
  height          INTEGER NOT NULL,
  seed            INTEGER NOT NULL,
  mime            TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  data            TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_gen_images_user ON gen_images(user_id, created_at DESC);

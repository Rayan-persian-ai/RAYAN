-- RAYAN Phase 4 — feature parity with the old static Space (tm13911391/rayan):
-- server-side conversation history, shareable read-only links, answer feedback,
-- per-user personalisation, support inbox and site announcements. Timestamps: epoch ms.

CREATE TABLE conversations (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  share_id    TEXT UNIQUE,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_conversations_user ON conversations(user_id, updated_at DESC);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  -- JSON: {engine, provider, sources:[{title,url}], image:{url,prompt,en,size,seed}, stopped, error, mode}
  meta            TEXT,
  rating          INTEGER CHECK (rating IN (-1, 1)),
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at);

CREATE TABLE user_prefs (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

CREATE TABLE support_tickets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  reply       TEXT,
  replied_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
  created_at  INTEGER NOT NULL,
  replied_at  INTEGER
);
CREATE INDEX idx_support_user ON support_tickets(user_id, created_at DESC);
CREATE INDEX idx_support_status ON support_tickets(status, created_at DESC);

CREATE TABLE announcements (
  id          TEXT PRIMARY KEY,
  body        TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_announcements_active ON announcements(active, created_at DESC);

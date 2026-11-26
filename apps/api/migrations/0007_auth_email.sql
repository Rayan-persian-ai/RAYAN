-- RAYAN Phase 4 batch 2 — Google sign-in, email codes, encrypted server-side secrets, email log.

ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
ALTER TABLE users ADD COLUMN google_sub TEXT;
CREATE UNIQUE INDEX idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;
-- Accounts that existed before email verification was introduced are grandfathered as verified.
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;

-- OAuth 2.0 state (+ PKCE verifier and nonce). id = SHA-256 of the state value sent to Google.
CREATE TABLE oauth_states (
  id          TEXT PRIMARY KEY,
  purpose     TEXT NOT NULL CHECK (purpose IN ('login', 'gmail')),
  verifier    TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX idx_oauth_states_expires ON oauth_states(expires_at);

-- One-time 6-digit email codes. Only an HMAC of the code is stored; 10-minute expiry; max 5 attempts.
CREATE TABLE email_codes (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL COLLATE NOCASE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('verify', 'login', 'reset')),
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX idx_email_codes_lookup ON email_codes(email, purpose, created_at DESC);

-- Server-side secrets written by the app itself (e.g. the Gmail refresh token from the owner's consent),
-- AES-GCM encrypted with a key derived from Worker secrets. Never returned by any API.
CREATE TABLE app_secrets (
  name        TEXT PRIMARY KEY,
  ciphertext  TEXT NOT NULL,
  iv          TEXT NOT NULL,
  updated_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at  INTEGER NOT NULL
);

-- Every outbound email (codes, agent emails): who, what, provider, result. Bodies are not stored.
CREATE TABLE email_log (
  id          TEXT PRIMARY KEY,
  to_email    TEXT NOT NULL,
  subject     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  provider    TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'logged')),
  error       TEXT,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_email_log_created ON email_log(created_at DESC);

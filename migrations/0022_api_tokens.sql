-- Personal API tokens for the read-only MCP endpoint, and a daily count of tool calls per user.
-- The table holds a hash, never a token. `session_version` copies `users.session_version` at
-- creation: a sign-in reset ends the token as it ends a session. `api_usage` holds one row per user,
-- overwritten each day, so no retention job is needed.

CREATE TABLE api_tokens (
  token_hash TEXT PRIMARY KEY, -- hex SHA-256 of the token
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  last_four TEXT NOT NULL,
  session_version INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT
);

CREATE INDEX api_tokens_user ON api_tokens (user_id);

CREATE TABLE api_usage (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  day TEXT NOT NULL, -- UTC date
  calls INTEGER NOT NULL DEFAULT 0
);

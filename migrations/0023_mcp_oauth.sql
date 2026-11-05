-- OAuth for the MCP endpoint: clients that registered themselves, short-lived authorization codes,
-- and one grant per user and client. Tables hold hashes, never a secret, a code or a token. Access
-- tokens are signed and not stored; each request reads the grant, so that ending it acts at once.

CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  secret_hash TEXT, -- hex SHA-256; NULL for a public client
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL, -- JSON array
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT -- the last connection; a client that connected once stays 180 days after it
);

-- The cleanup of unused clients reads only old rows through this index.
CREATE INDEX oauth_clients_used ON oauth_clients (last_used_at, created_at);

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL, -- the resource indicator of the request; the token's audience
  session_version INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX oauth_codes_expires ON oauth_codes (expires_at);
CREATE INDEX oauth_codes_client ON oauth_codes (client_id);
CREATE INDEX oauth_codes_user ON oauth_codes (user_id);

CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  session_version INTEGER NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  -- The code this grant came from. If the code comes back, someone copied it, and the grant ends.
  code_hash TEXT UNIQUE,
  -- Counts refreshes. A refresh token names its generation, so an older one shows a copy.
  generation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  refreshed_at TEXT,
  refresh_expires_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, -- the grant ends here, whatever its refreshes
  UNIQUE (user_id, client_id)
);

CREATE INDEX oauth_grants_client ON oauth_grants (client_id);

-- Registrations per UTC day: key 'all' for the deployment, 'ip:<keyed hash>' per address. A row
-- holds the day of its last registration; older rows go with the next registration.
CREATE TABLE oauth_registrations (
  key TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX oauth_registrations_day ON oauth_registrations (day);

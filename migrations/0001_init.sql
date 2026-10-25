-- Orgs, their users, the calendar accounts each user connected, and the sync rules between them.
-- Tokens and per-event state live in the AccountSync Durable Object of each account, not here.
-- A self-hosted deployment has exactly one org ('default'), kept in sync with its variables.

CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  policy TEXT NOT NULL DEFAULT '{}', -- JSON, validated by accessPolicySchema
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE, -- sign-in identity, lowercase
  tenant_id TEXT, -- Entra tenant of the sign-in identity; NULL for Google
  role TEXT NOT NULL CHECK (role IN ('member', 'admin')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_sign_in_at TEXT
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY, -- also the name of the account's Durable Object
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('microsoft', 'google')),
  email TEXT NOT NULL,
  tenant_id TEXT, -- Entra tenant ID; NULL for Google
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (provider, email) -- one calendar account belongs to one user
);

CREATE INDEX accounts_user ON accounts (user_id);

CREATE TABLE calendars (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL, -- calendar ID at the provider
  name TEXT NOT NULL,
  UNIQUE (account_id, remote_id)
);

CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_calendar_id TEXT NOT NULL REFERENCES calendars (id) ON DELETE CASCADE,
  target_calendar_id TEXT NOT NULL REFERENCES calendars (id) ON DELETE CASCADE,
  options TEXT NOT NULL DEFAULT '{}', -- JSON, validated by ruleOptionsSchema
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  CHECK (source_calendar_id <> target_calendar_id),
  UNIQUE (source_calendar_id, target_calendar_id)
);

CREATE INDEX rules_user ON rules (user_id);

CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL REFERENCES rules (id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error')),
  created INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE INDEX sync_runs_rule_started ON sync_runs (rule_id, started_at DESC);

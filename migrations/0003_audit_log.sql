-- Audit log: who did what and when, plus the outcome of every sync run.
-- Metadata only. `detail` holds counts and codes, never event titles, descriptions, attendees,
-- locations or tokens. Rows carry no foreign keys on purpose: the log outlives deleted rules,
-- accounts and users until the retention job removes it.

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  user_id TEXT,
  account_id TEXT,
  rule_id TEXT,
  kind TEXT NOT NULL, -- see AuditKind in src/audit.ts
  detail TEXT NOT NULL DEFAULT '{}', -- JSON: counts and codes only
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX audit_events_org_created ON audit_events (org_id, created_at DESC);
CREATE INDEX audit_events_user_created ON audit_events (user_id, created_at DESC);

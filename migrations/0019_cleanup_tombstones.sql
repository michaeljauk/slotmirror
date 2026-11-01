-- The removal of an offboarding as a row of its own. `AccountSync` holds the job while it runs; the
-- row keeps owner, target calendar, rule tag, progress and end state, also after the Durable Object
-- forgot its tokens. The row has no foreign keys on purpose: it outlives the rule, the account and
-- the user until the retention job removes it. It holds no event content. `block_title` is the
-- title a rule sets for its blocks, and stays NULL for a rule that copies event titles. One rule
-- writes into one calendar, so the key needs no calendar. The calendar ID of a primary Google
-- calendar is a mail address, and the state 'removed' clears it.

CREATE TABLE cleanup_tombstones (
  account_id TEXT NOT NULL, -- the account that holds the blocks
  remote_calendar_id TEXT, -- NULL once the blocks are removed
  rule_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  calendar_name TEXT, -- NULL for a job that a version without this table queued
  rule_tag TEXT NOT NULL, -- the marker that every block of the rule carries
  block_title TEXT,
  rule_was_off INTEGER NOT NULL DEFAULT 0, -- 1: the last sync run says nothing about the blocks
  state TEXT NOT NULL DEFAULT 'open', -- 'open', or a CleanupResult from src/audit.ts
  removed INTEGER NOT NULL DEFAULT 0,
  blocks_left INTEGER, -- NULL: no count exists
  left_estimated INTEGER NOT NULL DEFAULT 0, -- 1: the count comes from the last sync run
  window_start TEXT, -- ISO 8601: the period that holds the blocks
  window_end TEXT,
  deadline_at TEXT, -- ISO 8601, set by the job: on a paused account it ends then. NULL: no job
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  PRIMARY KEY (account_id, rule_id)
);

CREATE INDEX cleanup_tombstones_user ON cleanup_tombstones (user_id);
CREATE INDEX cleanup_tombstones_org ON cleanup_tombstones (org_id);

-- A rule that an offboarding stopped, and that runs again unless the offboarding succeeds. Each
-- request has its own row, so that a failed request never starts a rule that another request holds.
-- A row outlives a failed request. The cron handler reads it after `until`.
-- A later migration must not rebuild `rules` with a new table, a DROP and a RENAME. The DROP deletes
-- every row here through the foreign key, and it deletes the three triggers below for good.
CREATE TABLE rule_holds (
  rule_id TEXT NOT NULL REFERENCES rules (id) ON DELETE CASCADE,
  hold_id TEXT NOT NULL,
  until INTEGER NOT NULL, -- Unix ms
  PRIMARY KEY (rule_id, hold_id)
);

CREATE INDEX rule_holds_until ON rule_holds (until);

-- A rule that runs again needs no hold. This also covers a user who enables the rule, and a worker
-- of an earlier version that knows nothing of this table.
CREATE TRIGGER rule_holds_end AFTER UPDATE OF enabled ON rules WHEN NEW.enabled = 1
BEGIN
  DELETE FROM rule_holds WHERE rule_id = NEW.id;
END;

-- A rule that runs owns its blocks, so an ended tombstone of the rule is out of date. The page hides
-- such a row while the rule runs. The row goes once the rule stops, or the page would show it again.
-- An editor stop or a delete queues its own removal. `/rules/:id/pause` does not: its blocks stay
-- with the paused rule, which the user sees. A deactivated user keeps the row: the page shows it.
CREATE TRIGGER cleanup_tombstones_rule_off AFTER UPDATE OF enabled ON rules
WHEN OLD.enabled = 1 AND NEW.enabled = 0
BEGIN
  DELETE FROM cleanup_tombstones
  WHERE rule_id = NEW.id AND state <> 'open'
    AND EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.user_id AND u.active = 1);
END;

CREATE TRIGGER cleanup_tombstones_rule_gone AFTER DELETE ON rules WHEN OLD.enabled = 1
BEGIN
  DELETE FROM cleanup_tombstones
  WHERE rule_id = OLD.id AND state <> 'open'
    AND EXISTS (SELECT 1 FROM users u WHERE u.id = OLD.user_id AND u.active = 1);
END;

-- The ID of a stored cleanup report, so that a repeated D1 step writes no second event. A lost answer
-- of a step that worked leaves the report in the Durable Object, which writes it again.
ALTER TABLE audit_events ADD COLUMN report_id TEXT;
CREATE UNIQUE INDEX audit_events_report ON audit_events (report_id) WHERE report_id IS NOT NULL;

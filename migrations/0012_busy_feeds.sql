-- Private free/busy feeds: a secret ICS address that shows only the busy times of calendars the
-- user chose. Only the SHA-256 hash of the secret token is stored; the token is shown once.
-- `uid_salt` keys the event UIDs, so that they reveal no source event ID and differ per feed.
-- A feed goes with its user, and a calendar leaves every feed when its account goes.
-- The last rendered feed stays in the row, so that a fetch within 15 minutes needs no calendar
-- read, and a throttled account can serve its last copy.

CREATE TABLE feeds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL, -- hex SHA-256 of the token
  uid_salt TEXT NOT NULL, -- hex, 32 random bytes
  days_ahead INTEGER NOT NULL DEFAULT 60 CHECK (days_ahead BETWEEN 1 AND 180),
  include_all_day INTEGER NOT NULL DEFAULT 0 CHECK (include_all_day IN (0, 1)),
  locale TEXT NOT NULL DEFAULT 'en', -- language of the fixed event title
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  rotated_at TEXT,
  last_body TEXT, -- the last rendered ICS: busy times only
  last_rendered_at INTEGER, -- Unix ms
  last_key TEXT, -- calendars and settings the last body was rendered from
  cut_at TEXT, -- set if the last body ends early because of the event cap
  error_calendar_id TEXT, -- a calendar the provider no longer lets the account read
  error_until INTEGER -- Unix ms: until then, a failed read answers again without a new read
);

CREATE INDEX feeds_user ON feeds (user_id);

CREATE TABLE feed_calendars (
  feed_id TEXT NOT NULL REFERENCES feeds (id) ON DELETE CASCADE,
  calendar_id TEXT NOT NULL REFERENCES calendars (id) ON DELETE CASCADE,
  PRIMARY KEY (feed_id, calendar_id)
);

CREATE INDEX feed_calendars_calendar ON feed_calendars (calendar_id);

-- Whether the account owns the calendar. Only owned calendars may go into a feed, so that nobody
-- publishes the busy times of a calendar someone else shared with them. Until the next calendar
-- refresh, a calendar slotmirror may write into counts as owned: it is only writable when owned.
ALTER TABLE calendars ADD COLUMN owned INTEGER NOT NULL DEFAULT 0 CHECK (owned IN (0, 1));
UPDATE calendars SET owned = 1 WHERE can_edit = 1;

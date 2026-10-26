-- Private free/busy feeds: a secret ICS address that shows only the busy times of calendars the
-- user chose. Only the SHA-256 hash of the secret token is stored; the token is shown once.
-- `uid_salt` keys the event UIDs, so that they reveal no source event ID and differ per feed.
-- A feed goes with its user, and a calendar leaves every feed when its account goes.

CREATE TABLE feeds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL, -- hex SHA-256 of the token
  uid_salt TEXT NOT NULL, -- hex, 32 random bytes
  days_ahead INTEGER NOT NULL DEFAULT 60 CHECK (days_ahead BETWEEN 1 AND 180),
  include_all_day INTEGER NOT NULL DEFAULT 0 CHECK (include_all_day IN (0, 1)),
  locale TEXT NOT NULL DEFAULT 'en', -- language of the fixed event title
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  rotated_at TEXT
);

CREATE INDEX feeds_user ON feeds (user_id);

CREATE TABLE feed_calendars (
  feed_id TEXT NOT NULL REFERENCES feeds (id) ON DELETE CASCADE,
  calendar_id TEXT NOT NULL REFERENCES calendars (id) ON DELETE CASCADE,
  PRIMARY KEY (feed_id, calendar_id)
);

CREATE INDEX feed_calendars_calendar ON feed_calendars (calendar_id);

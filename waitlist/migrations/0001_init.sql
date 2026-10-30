-- One row per normalized address (trim, lowercase). Tokens are stored as SHA-256 hashes.
CREATE TABLE subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  confirm_hash TEXT NOT NULL,
  confirm_expires_at INTEGER NOT NULL,
  unsubscribe_hash TEXT NOT NULL,
  unsubscribe_expires_at INTEGER NOT NULL,
  mail_sent_at INTEGER,
  confirmed_at INTEGER
);
CREATE UNIQUE INDEX subscribers_confirm_hash ON subscribers (confirm_hash);
CREATE UNIQUE INDEX subscribers_unsubscribe_hash ON subscribers (unsubscribe_hash);

-- Mails reserved per UTC day (YYYY-MM-DD). Global cap.
CREATE TABLE mail_counter (
  day TEXT PRIMARY KEY,
  reserved INTEGER NOT NULL
) WITHOUT ROWID;

-- Sign-up attempts per hashed IP key and hour. No plain IP address is stored.
CREATE TABLE rate_hits (
  key_hash TEXT NOT NULL,
  window INTEGER NOT NULL,
  hits INTEGER NOT NULL,
  PRIMARY KEY (key_hash, window)
) WITHOUT ROWID;

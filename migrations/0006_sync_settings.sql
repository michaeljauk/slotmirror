-- Settings that apply to all rules of a user: time window, which events count, private blocks.
ALTER TABLE users ADD COLUMN sync_settings TEXT NOT NULL DEFAULT '{}';

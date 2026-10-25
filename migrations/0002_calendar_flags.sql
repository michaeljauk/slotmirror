-- Whether freebusy-sync may write into a calendar, and which calendar is the account's default.
ALTER TABLE calendars ADD COLUMN can_edit INTEGER NOT NULL DEFAULT 0 CHECK (can_edit IN (0, 1));
ALTER TABLE calendars ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1));

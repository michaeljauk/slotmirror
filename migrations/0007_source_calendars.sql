-- Which calendars of an account the editor uses as sources. The main calendar starts as one;
-- other calendars, such as subscriptions, join when the user turns them on.
ALTER TABLE calendars ADD COLUMN is_source INTEGER NOT NULL DEFAULT 0 CHECK (is_source IN (0, 1));
UPDATE calendars SET is_source = 1 WHERE is_default = 1;

-- Until when a provider sends change notifications for a calendar (Unix ms), or NULL without an
-- active watch. The cron polls only rules whose calendars have no active watch.
ALTER TABLE calendars ADD COLUMN watched_until INTEGER;

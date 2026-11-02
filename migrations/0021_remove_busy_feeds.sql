-- The free/busy feeds are gone. `calendars.data_owned` existed only to decide which calendars a feed
-- may show; mirror targets use `can_edit`. The lease of 0018 goes with `feeds`. The audit log keeps
-- its feed events until retention, and a Durable Object keeps its unused `feedOwnershipCheckAt`.

DROP TABLE feed_calendars;
DROP TABLE feeds;
ALTER TABLE calendars DROP COLUMN data_owned;

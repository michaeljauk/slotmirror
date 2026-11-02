-- The render lease leaves `error_until`. A lease that shared the column with a failure also had to
-- clear `error_calendar_id`, so a parallel fetch could not see that a calendar was lost.

ALTER TABLE feeds ADD COLUMN lease_until INTEGER; -- Unix ms: until then, one fetch reads and renders

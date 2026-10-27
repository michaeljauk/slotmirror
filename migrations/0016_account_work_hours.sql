-- Working hours of an account: events that are copied into the account count only inside them, for
-- the directions that opt in. JSON with workDays, workStart, workEnd and workTimeZone, as in the
-- rule options; NULL means no working hours. The editor copies them into the options of each rule
-- that opts in, so the sync engine reads them from the rule as before. Numbered 0016 because
-- 0013 to 0015 are taken by another branch.
ALTER TABLE accounts ADD COLUMN work_hours TEXT;

-- Options of an account as a source, which every rule from the account shares, such as the buffer
-- around its events. JSON with rule option fields; NULL means the account never stored any, and
-- its rules keep what they have. The editor copies them into every rule from the account.
ALTER TABLE accounts ADD COLUMN source_options TEXT;

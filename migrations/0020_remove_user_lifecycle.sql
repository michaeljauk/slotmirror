-- SCIM is gone, and with it the only way to deactivate a user. Deleting a user in `/admin` is the
-- offboarding path. `session_version` stays: the sign-in reset raises it.
--
-- A user with `active = 0` counts as active after this migration: they can sign in again, and their
-- rules run. Before you apply it to a deployment that used SCIM, delete such users in `/admin`.
--
-- The two triggers of 0019 read `users.active`, so they go first. SQLite can keep a trigger when a
-- column it reads goes, and the next ALTER TABLE on `users` then fails. The new triggers keep the
-- check for the user row: when a user goes, their rules go through the foreign key after the row,
-- and the tombstones stay for the admin. This migration changes no row.

DROP TRIGGER cleanup_tombstones_rule_off;
DROP TRIGGER cleanup_tombstones_rule_gone;

ALTER TABLE users DROP COLUMN external_id;
ALTER TABLE users DROP COLUMN active;

-- A rule that runs owns its blocks, so an ended tombstone of the rule is out of date. The page hides
-- such a row while the rule runs. The row goes once the rule stops, or the page would show it again.
-- An editor stop or a delete queues its own removal. `/rules/:id/pause` does not: its blocks stay
-- with the paused rule, which the user sees.
CREATE TRIGGER cleanup_tombstones_rule_off AFTER UPDATE OF enabled ON rules
WHEN OLD.enabled = 1 AND NEW.enabled = 0
BEGIN
  DELETE FROM cleanup_tombstones
  WHERE rule_id = NEW.id AND state <> 'open'
    AND EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.user_id);
END;

CREATE TRIGGER cleanup_tombstones_rule_gone AFTER DELETE ON rules WHEN OLD.enabled = 1
BEGIN
  DELETE FROM cleanup_tombstones
  WHERE rule_id = OLD.id AND state <> 'open'
    AND EXISTS (SELECT 1 FROM users u WHERE u.id = OLD.user_id);
END;

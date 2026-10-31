-- A session carries the version of its user at sign-in. Raising the version ends every session of
-- the user, for example when SCIM changes the sign-in address. Existing sessions carry no version
-- and count as version 0, so this migration ends none of them.
ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;

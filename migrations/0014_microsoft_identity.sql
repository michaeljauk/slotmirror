-- The Microsoft identity a user is bound to: Entra tenant ID and object ID from the first
-- Microsoft sign-in. A later Microsoft sign-in with the same address but another tenant or object
-- is refused. Users from before this migration are bound at their next Microsoft sign-in.
ALTER TABLE users ADD COLUMN ms_tenant_id TEXT;
ALTER TABLE users ADD COLUMN ms_object_id TEXT;
-- One Microsoft identity binds at most one user.
CREATE UNIQUE INDEX users_ms_identity ON users (ms_tenant_id, ms_object_id)
  WHERE ms_object_id IS NOT NULL;

-- Set when the provider refuses an account's refresh token for good, for example after the user
-- revoked access. The accounts page then asks the user to connect the account again.
ALTER TABLE accounts ADD COLUMN needs_reconnect INTEGER NOT NULL DEFAULT 0
  CHECK (needs_reconnect IN (0, 1));

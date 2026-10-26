-- Users that Entra provisions over SCIM: their ID in Entra, and whether they are active. A
-- deactivated user cannot sign in, and their rules stop until Entra activates them again.
ALTER TABLE users ADD COLUMN external_id TEXT;
ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1));

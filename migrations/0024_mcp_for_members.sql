-- Whether members, not only admins, may use MCP: create personal tokens, connect apps and call
-- /mcp. 'off' or 'all'; src/permissions.ts reads any other value as 'off'. A new org starts with
-- 'off'. An org that exists already keeps what it had before: every member could use MCP.
-- A column and not a field of `policy`, because every sign-in writes the default org's policy anew
-- from the Worker variables.
ALTER TABLE orgs ADD COLUMN mcp_for_members TEXT NOT NULL DEFAULT 'off';

UPDATE orgs SET mcp_for_members = 'all';

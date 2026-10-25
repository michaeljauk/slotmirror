-- The calendar editor: accounts in the block group see each other as busy. Rules record whether
-- they come from the group or are an exception the user chose.
ALTER TABLE accounts ADD COLUMN in_block_group INTEGER NOT NULL DEFAULT 0
  CHECK (in_block_group IN (0, 1));
ALTER TABLE rules ADD COLUMN origin TEXT NOT NULL DEFAULT 'custom'
  CHECK (origin IN ('group', 'custom'));

-- Colour of an account in the slotmirror pages: a key of the palette in src/colors.ts.
-- NULL means automatic; the app then picks the next unused colour.
ALTER TABLE accounts ADD COLUMN color TEXT;

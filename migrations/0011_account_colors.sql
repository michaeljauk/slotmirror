-- Colour of an account in the slotmirror pages: a key of the palette in src/colors.ts.
-- "<key>" is a colour the user chose, "auto:<key>" one that slotmirror assigned and keeps.
-- NULL means not assigned yet; the next page load assigns the next unused colour.
ALTER TABLE accounts ADD COLUMN color TEXT;

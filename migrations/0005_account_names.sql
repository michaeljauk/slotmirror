-- A name the user gives an account, e.g. "NetCero". Null means the name derived from the address.
ALTER TABLE accounts ADD COLUMN display_name TEXT;

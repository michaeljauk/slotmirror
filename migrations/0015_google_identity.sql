-- The Google identity a user is bound to: the `sub` claim from the first Google sign-in. A user
-- bound to one provider signs in only with that provider.
ALTER TABLE users ADD COLUMN google_subject TEXT;
-- One Google identity binds at most one user.
CREATE UNIQUE INDEX users_google_subject ON users (google_subject)
  WHERE google_subject IS NOT NULL;
-- After an admin reset the binding: until `rebind_until`, a sign-in with a verified address may
-- bind the user again. `refused_subjects` (JSON array) holds the identities bound before the
-- reset; they never bind this user again.
ALTER TABLE users ADD COLUMN rebind_until TEXT;
ALTER TABLE users ADD COLUMN refused_subjects TEXT;

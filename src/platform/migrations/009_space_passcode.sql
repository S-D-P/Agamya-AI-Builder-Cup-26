-- Optional space passcode: the owner can require it, on top of each person's own password, before anyone enters the
-- space. Only a hash is stored. Unlocking lasts for one sign-in session. Additive only.
ALTER TABLE organizations ADD COLUMN passcode_hash text;
ALTER TABLE organizations ADD COLUMN passcode_set_at timestamptz;
ALTER TABLE auth_sessions ADD COLUMN unlocked_orgs uuid[] NOT NULL DEFAULT '{}';

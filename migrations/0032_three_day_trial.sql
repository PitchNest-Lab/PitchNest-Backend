-- The full-access Pro trial for new accounts is 3 days (was 30).
-- Depends on 0031 only through the migration ledger.
--
-- The backend stores trial_expires_at = signup + FREE_TRIAL_DAYS explicitly.
-- This aligns the column default, so a row inserted without it gets the same
-- 3 days. Trials that were already granted keep their end date.

BEGIN;

ALTER TABLE users
  ALTER COLUMN trial_expires_at SET DEFAULT (now() + interval '3 days');

INSERT INTO schema_migrations (version, description)
VALUES ('0032', 'Three-day Pro trial default for new accounts')
ON CONFLICT (version) DO NOTHING;

COMMIT;

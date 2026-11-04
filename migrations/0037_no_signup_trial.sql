-- New accounts start on the Free plan, with no Pro trial.
-- Depends on 0032 (three-day trial default).
--
-- The backend writes the trial columns of a new account explicitly
-- (newAccountTrialFields: no dates, trial_status 'none'), so this only keeps
-- the column defaults truthful for any other insert. Trials already granted
-- keep their stored end date; nothing here changes an existing row.

BEGIN;

ALTER TABLE users
  ALTER COLUMN trial_started_at SET DEFAULT NULL,
  ALTER COLUMN trial_expires_at SET DEFAULT NULL,
  ALTER COLUMN trial_status SET DEFAULT 'none';

INSERT INTO schema_migrations (version, description)
VALUES ('0037', 'New accounts start on Free with no Pro trial')
ON CONFLICT (version) DO NOTHING;

COMMIT;

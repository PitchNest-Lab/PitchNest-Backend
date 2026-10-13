-- Migration 0016: Free full-access trial is 3 days (was 30).
--
-- Run once against Supabase (SQL editor or psql). Idempotent — safe to re-run.
--
-- WHY
-- Product decision (11 Oct): new users get 3 days of full access, then the
-- normal free limits apply so the upgrade path is visible. The backend now
-- stores trial_expires_at = signup + FREE_TRIAL_DAYS (default 3). Migration
-- 0011 left the column DEFAULT at 30 days, so any insert that doesn't set it
-- explicitly would still get 30 days. Part A fixes that.

-- ── Part A (always run): new rows default to a 3-day trial ───────────────────
ALTER TABLE users
  ALTER COLUMN trial_expires_at SET DEFAULT (now() + interval '3 days');

-- ── Part B (OPTIONAL, run only if the team agrees) ───────────────────────────
-- Shortens trials that are still running for existing free users to 3 days
-- from when they started. Anyone who signed up more than 3 days ago loses full
-- access immediately and drops to the free plan. Paid users are untouched.
-- Preview first:
--   SELECT id, email, trial_started_at, trial_expires_at
--     FROM users
--    WHERE trial_expires_at > now()
--      AND COALESCE(plan, 'free') = 'free'
--      AND COALESCE(trial_status, 'active') = 'active';
--
-- UPDATE users
--    SET trial_expires_at = LEAST(
--          trial_expires_at,
--          COALESCE(trial_started_at, now()) + interval '3 days'
--        )
--  WHERE trial_expires_at > now()
--    AND COALESCE(plan, 'free') = 'free'
--    AND COALESCE(trial_status, 'active') = 'active';

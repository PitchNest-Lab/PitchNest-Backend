-- Migration 0005: Add per-account login lockout columns to users table.
--
-- Run once against Supabase (SQL editor or psql). Idempotent — safe to re-run.
--
-- After 5 consecutive failed login attempts the account is locked for 15
-- minutes. The counter resets on a successful login. The backend checks
-- these columns in the login handler.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS failed_login_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS locked_until timestamptz;

-- Migration 0001: add `role` to the users table.
--
-- Run this once against the Supabase project (SQL editor or `psql`). It is
-- idempotent — re-running it is safe. There is no migration runner in this repo
-- yet, so migrations live here as numbered SQL files and are applied manually,
-- the same convention used for the password_resets / email verification tables.
--
-- Role is one of: Founder | Investor | Advisor. New rows default to 'Founder';
-- existing rows are backfilled to 'Founder'.

-- 1. Add the column with a safe default (also backfills existing rows).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'Founder';

-- 2. Explicit backfill for any pre-existing NULLs (no-op when the default
--    already applied, kept for clarity/safety).
UPDATE users SET role = 'Founder' WHERE role IS NULL;

-- 3. Constrain to the three allowed values.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check CHECK (role IN ('Founder', 'Investor', 'Advisor'));
